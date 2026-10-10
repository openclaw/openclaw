import type { WorkboardCard, WorkboardSessionsBoardView } from "@openclaw/workboard-contract";
import { readStringParam } from "openclaw/plugin-sdk/core";
import { captureLocalStateMutationGuard } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import {
  assertNoCursorAdvance,
  createWorkboardDispatchHandler,
  readId,
  readExpectedUpdatedAt,
  readPatch,
  resolveGatewayWorkspaceMutationAccess,
  respondError,
  WorkboardUploadsDisabledError,
  type GatewayMethodContext,
} from "./gateway-helpers.js";
import type { WorkboardSessionsBoardService } from "./sessions-board.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./sqlite-store-paths.js";
import { registerWorkboardStoreLifecycle } from "./store-lifecycle.js";
import { WorkboardStore } from "./store.js";
import {
  containsWorkboardWorkspaceMutation,
  withWorkboardDecomposeWorkspaceAccess,
  withWorkboardWorkspaceAccess,
  withoutWorkboardWorkspaceAccess,
} from "./workspace-access.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const CLI_OWNER_METHODS = new Set([
  "workboard.cards.list",
  "workboard.cards.create",
  "workboard.cards.move",
  "workboard.cards.dispatch",
  "workboard.cards.dispatchWithOptions",
]);

function sessionsBoardView(input: Record<string, unknown>): WorkboardSessionsBoardView | undefined {
  const unknownParam = Object.keys(input).find(
    (key) => key !== "boardId" && key !== "view" && key !== "sinceRevision",
  );
  if (unknownParam) {
    throw new Error(`Unknown Sessions board read field: ${unknownParam}.`);
  }
  if (input.view === undefined) {
    return undefined;
  }
  if (!isRecord(input.view)) {
    throw new Error("view must be an object.");
  }
  const view: WorkboardSessionsBoardView = {};
  for (const [key, value] of Object.entries(input.view)) {
    switch (key) {
      case "involvingMe":
      case "includePeople":
        if (typeof value !== "boolean") {
          throw new Error(`view.${key} must be a boolean.`);
        }
        view[key] = value;
        break;
      case "involvingProfileId":
        if (typeof value !== "string") {
          throw new Error("view.involvingProfileId must be a string.");
        }
        view.involvingProfileId = value;
        break;
      default:
        throw new Error(`Unknown Sessions board view field: ${key}.`);
    }
  }
  return view;
}

/**
 * Interactive Sessions-board writes wait in the store's mutation queue, so the
 * caller's full Gateway authority (transport, role/scope/profile authorization,
 * in-process lifetime) is rechecked immediately before the SQLite write.
 */
function sessionsBoardCaller(
  context: Pick<
    GatewayMethodContext,
    | "hasCurrentClientAuthority"
    | "sessionMutationAuthorization"
    | "sessionAccessAuthority"
    | "sessionMutationCommitGuard"
    | "signal"
  >,
) {
  return {
    assertCurrent() {
      context.signal?.throwIfAborted();
      if (context.hasCurrentClientAuthority?.() === false) {
        throw new Error("Caller authority is no longer active.");
      }
      context.sessionAccessAuthority?.assertCurrent();
      context.sessionMutationAuthorization?.assertCurrent();
      context.sessionMutationCommitGuard?.();
    },
  };
}

function redactDiagnosticsRows(result: Awaited<ReturnType<WorkboardStore["diagnostics"]>>) {
  return {
    ...result,
    diagnostics: result.diagnostics.map((row) => ({
      ...row,
      card: redactClaimToken(row.card),
    })),
  };
}

async function redactCardResult(card: Promise<WorkboardCard>) {
  return { card: redactClaimToken(await card) };
}

export function registerWorkboardGatewayMethods(params: {
  api: OpenClawPluginApi;
  store?: WorkboardStore;
  sessionsBoard?: Pick<WorkboardSessionsBoardService, "read" | "update" | "move">;
}) {
  const { api } = params;
  const assertUploadsAllowed = (client: GatewayMethodContext["client"]) => {
    if (
      !client?.internal?.syntheticClient &&
      !client?.internal?.agentRuntimeIdentity &&
      api.runtime.config.current().gateway?.uploads?.enabled === false
    ) {
      throw new WorkboardUploadsDisabledError();
    }
  };
  const store =
    params.store ??
    WorkboardStore.openSqlite(resolveWorkboardSqliteWorkerModuleUrl(api.runtimeSource));
  if (!params.store) {
    registerWorkboardStoreLifecycle(api, store);
  }
  const register = (
    method: string,
    scope: typeof READ_SCOPE | typeof WRITE_SCOPE,
    handler: (request: GatewayMethodContext) => unknown,
  ) => {
    const requestHandler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1] = async (
      initialRequest,
    ) => {
      let request = initialRequest;
      let assertOwnerCurrent: (() => void) | undefined;
      if (request.params?.expectedOwnerId !== undefined) {
        try {
          const expectedOwnerId = readStringParam(request.params, "expectedOwnerId", {
            required: true,
          });
          assertOwnerCurrent = captureLocalStateMutationGuard(expectedOwnerId, request);
        } catch (error) {
          request.respond(false, undefined, {
            code: "UNAVAILABLE",
            message: String(error),
            details: { mutationAccepted: false },
          });
          return;
        }
        const { expectedOwnerId: _expectedOwnerId, ...input } = request.params;
        const previousGuard = request.sessionMutationCommitGuard;
        request = {
          ...request,
          params: input,
          sessionMutationCommitGuard: () => {
            previousGuard?.();
            assertOwnerCurrent?.();
          },
        };
      }
      try {
        await store.runOperation(async () => {
          assertOwnerCurrent?.();
          if (method === "workboard.cards.attachments.add") {
            assertUploadsAllowed(request.client);
          }
          request.respond(true, await handler(request));
        });
      } catch (error) {
        respondError(request.respond, error);
      }
    };
    api.registerGatewayMethod(method, requestHandler, { scope });
    if (CLI_OWNER_METHODS.has(method)) {
      api.registerGatewayMethod(
        `${method}.owner`,
        (request) => {
          if (
            typeof request.params?.expectedOwnerId !== "string" ||
            !request.params.expectedOwnerId.trim()
          ) {
            request.respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "expectedOwnerId is required",
              details: { mutationAccepted: false },
            });
            return;
          }
          return requestHandler(request);
        },
        { scope },
      );
    }
  };
  const cardMutation = (
    method: string,
    mutate: (id: string, input: Record<string, unknown>) => Promise<WorkboardCard>,
  ) =>
    register(`workboard.cards.${method}`, WRITE_SCOPE, ({ params: input }) =>
      redactCardResult(mutate(readId(input), input)),
    );
  const dispatchCards = createWorkboardDispatchHandler({ api, store });

  register("workboard.cards.list", READ_SCOPE, async ({ params: input }) => {
    const result = await store.listCards(input.boardId);
    const since = input.sinceRevision;
    return isRecord(since) &&
      since.epoch === result.revision.epoch &&
      since.revision === result.revision.revision &&
      since.boardId === result.revision.boardId
      ? { unchanged: true, revision: result.revision }
      : result;
  });
  for (const method of ["create", "captureSession"] as const) {
    register(`workboard.cards.${method}`, WRITE_SCOPE, async (request) => {
      const input = withoutWorkboardWorkspaceAccess(request.params);
      const access = await resolveGatewayWorkspaceMutationAccess(request, input);
      const prepared = withWorkboardWorkspaceAccess(input, access);
      return redactCardResult(
        method === "create"
          ? store.create(prepared, undefined, request.sessionMutationCommitGuard)
          : store.captureSession(prepared),
      );
    });
  }
  register("workboard.cards.update", WRITE_SCOPE, async (request) => {
    const patch = withoutWorkboardWorkspaceAccess(readPatch(request.params));
    const access = await resolveGatewayWorkspaceMutationAccess(request, patch);
    const expectedUpdatedAt = readExpectedUpdatedAt(request.params);
    return redactCardResult(
      store.update(
        readId(request.params),
        containsWorkboardWorkspaceMutation(patch)
          ? withWorkboardWorkspaceAccess(patch, access)
          : patch,
        { expectedUpdatedAt },
      ),
    );
  });
  register("workboard.cards.start", WRITE_SCOPE, (request) =>
    dispatchCards(request, { supportsMaxStarts: false, directCard: true }),
  );
  register("workboard.cards.move", WRITE_SCOPE, ({ params: input, sessionMutationCommitGuard }) =>
    redactCardResult(
      store.move(readId(input), input.status, input.position, undefined, {
        expectedUpdatedAt: readExpectedUpdatedAt(input),
        assertOwnerCurrent: sessionMutationCommitGuard,
      }),
    ),
  );
  register("workboard.cards.delete", WRITE_SCOPE, ({ params: input }) =>
    store.delete(readId(input), { expectedUpdatedAt: readExpectedUpdatedAt(input) }),
  );
  cardMutation("comment", (id, input) => store.addComment(id, input));
  cardMutation("link", (id, input) => store.addLink(id, input));
  register("workboard.cards.linkDependency", WRITE_SCOPE, ({ params: input }) => {
    const { parentId, childId } = input;
    if (typeof parentId !== "string" || typeof childId !== "string") {
      throw new Error("parentId and childId are required.");
    }
    return redactCardResult(store.linkCards(parentId, childId));
  });
  cardMutation("proof", (id, input) => store.addProof(id, input));
  cardMutation("artifact", (id, input) => store.addArtifact(id, input));
  register("workboard.cards.claim", WRITE_SCOPE, async ({ params: input }) => {
    const claimed = await store.claim(readId(input), input);
    return { ...claimed, card: redactClaimToken(claimed.card) };
  });
  cardMutation("heartbeat", (id, input) => store.heartbeat(id, input));
  cardMutation("release", (id, input) => store.releaseClaim(id, input));
  cardMutation("promote", (id, input) => store.promote(id, input, null));
  cardMutation("reassign", (id, input) => store.reassign(id, input, null));
  cardMutation("reclaim", (id, input) => store.reclaim(id, input, null));
  cardMutation("complete", (id, input) => store.complete(id, input, null));
  cardMutation("block", (id, input) => store.block(id, input, null));
  cardMutation("unblock", (id) => store.unblock(id));
  register("workboard.cards.bulk", WRITE_SCOPE, async (request) => {
    const input = withoutWorkboardWorkspaceAccess(request.params);
    const patch = withoutWorkboardWorkspaceAccess(readPatch(request.params));
    const access = await resolveGatewayWorkspaceMutationAccess(request, patch);
    const result = await store.bulkUpdate({
      ...input,
      patch: containsWorkboardWorkspaceMutation(patch)
        ? withWorkboardWorkspaceAccess(patch, access)
        : patch,
    });
    return { cards: result.cards.map(redactClaimToken) };
  });
  register("workboard.cards.diagnostics", READ_SCOPE, async () =>
    redactDiagnosticsRows(await store.diagnostics()),
  );
  register("workboard.cards.diagnostics.refresh", WRITE_SCOPE, async () =>
    redactDiagnosticsRows(await store.refreshDiagnostics()),
  );
  register("workboard.cards.dispatch", WRITE_SCOPE, (request) =>
    dispatchCards(request, { supportsMaxStarts: false }),
  );
  register("workboard.cards.dispatchWithOptions", WRITE_SCOPE, (request) =>
    dispatchCards(request, { supportsMaxStarts: true }),
  );
  register("workboard.boards.list", READ_SCOPE, () => store.listBoards());
  register("workboard.boards.upsert", WRITE_SCOPE, async (request) => {
    await resolveGatewayWorkspaceMutationAccess(request, request.params);
    return { board: await store.upsertBoard(request.params) };
  });
  const sessionsBoard = () => {
    if (!params.sessionsBoard) {
      throw new Error("Sessions board service is unavailable.");
    }
    return params.sessionsBoard;
  };
  register("workboard.sessionsBoard.read", READ_SCOPE, async (request) => {
    const result = await sessionsBoard().read(
      readStringParam(request.params, "boardId", { required: true }),
      sessionsBoardView(request.params),
      sessionsBoardCaller(request),
    );
    const since = request.params.sinceRevision;
    return isRecord(since) &&
      result.revision &&
      since.epoch === result.revision.epoch &&
      since.revision === result.revision.revision &&
      since.boardId === result.revision.boardId &&
      since.scope === result.revision.scope
      ? { unchanged: true, revision: result.revision }
      : result;
  });
  register("workboard.sessionsBoard.update", WRITE_SCOPE, async (request) => {
    const input = request.params;
    const boardId = readStringParam(input, "boardId", { required: true });
    if (!isRecord(input.patch)) {
      throw new Error("patch must be an object.");
    }
    return {
      board: await sessionsBoard().update(boardId, input.patch, sessionsBoardCaller(request)),
    };
  });
  register("workboard.sessionsBoard.move", WRITE_SCOPE, (request) =>
    sessionsBoard().move(
      readStringParam(request.params, "boardId", { required: true }),
      readStringParam(request.params, "sessionKey", { required: true }),
      readStringParam(request.params, "columnId", { required: true }),
      sessionsBoardCaller(request),
    ),
  );
  register("workboard.boards.archive", WRITE_SCOPE, async ({ params: input }) => ({
    board: await store.archiveBoard(input.id, input.archived),
  }));
  register("workboard.boards.delete", WRITE_SCOPE, ({ params: input }) =>
    store.deleteBoard(input.id),
  );
  register("workboard.cards.stats", READ_SCOPE, ({ params: input }) =>
    store.stats({ boardId: input.boardId }),
  );
  register("workboard.cards.runs", READ_SCOPE, async ({ params: input }) => {
    const result = await store.runs(readId(input));
    return { ...result, card: redactClaimToken(result.card) };
  });
  register("workboard.cards.specify", WRITE_SCOPE, async (request) => {
    const input = withoutWorkboardWorkspaceAccess(request.params);
    const access = await resolveGatewayWorkspaceMutationAccess(request, input);
    return redactCardResult(
      store.specify(
        readId(request.params),
        containsWorkboardWorkspaceMutation(input)
          ? withWorkboardWorkspaceAccess(input, access)
          : input,
        null,
      ),
    );
  });
  register("workboard.cards.decompose", WRITE_SCOPE, async (request) => {
    const input = withoutWorkboardWorkspaceAccess(request.params);
    const access = await resolveGatewayWorkspaceMutationAccess(request, input);
    const result = await store.decompose(
      readId(request.params),
      withWorkboardDecomposeWorkspaceAccess(input, access),
      null,
    );
    return {
      parent: redactClaimToken(result.parent),
      children: result.children.map(redactClaimToken),
    };
  });
  register("workboard.notifications.subscribe", WRITE_SCOPE, async ({ params: input }) => ({
    subscription: await store.subscribeNotifications(input),
  }));
  register("workboard.notifications.list", READ_SCOPE, ({ params: input }) =>
    store.listNotificationSubscriptions(input),
  );
  register("workboard.notifications.delete", WRITE_SCOPE, ({ params: input }) =>
    store.deleteNotificationSubscription(readId(input)),
  );
  register("workboard.notifications.events", READ_SCOPE, ({ params: input }) => {
    assertNoCursorAdvance(input);
    return store.notificationEvents(input);
  });
  register("workboard.notifications.advance", WRITE_SCOPE, ({ params: input }) =>
    store.advanceNotificationEvents(input),
  );
  register("workboard.cards.attachments.list", READ_SCOPE, async ({ params: input }) => {
    const result = await store.listAttachments(readId(input));
    return { ...result, card: redactClaimToken(result.card) };
  });
  register("workboard.cards.attachments.get", READ_SCOPE, async ({ params: input }) => {
    const attachment = await store.getAttachment(readId(input));
    if (!attachment) {
      throw new Error(`attachment not found: ${readId(input)}`);
    }
    return attachment;
  });
  register("workboard.cards.attachments.add", WRITE_SCOPE, ({ params: input, client }) =>
    redactCardResult(
      store.addAttachment(readId(input), input, undefined, () => assertUploadsAllowed(client)),
    ),
  );
  register("workboard.cards.attachments.delete", WRITE_SCOPE, ({ params: input }) => {
    const attachmentId = input.attachmentId;
    if (typeof attachmentId !== "string" || !attachmentId.trim()) {
      throw new Error("attachmentId is required.");
    }
    return redactCardResult(store.deleteAttachment(readId(input), attachmentId.trim()));
  });
  cardMutation("workerLog", (id, input) => store.addWorkerLog(id, input));
  cardMutation("protocolViolation", (id, input) => store.recordProtocolViolation(id, input));
  register("workboard.cards.archive", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(
      store.archive(readId(input), input.archived, {
        expectedUpdatedAt: readExpectedUpdatedAt(input),
      }),
    ),
  );
  register("workboard.cards.export", READ_SCOPE, async () => {
    const exported = await store.exportCards();
    return { ...exported, cards: exported.cards.map(redactClaimToken) };
  });
}
