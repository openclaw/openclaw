import type { WorkboardCard, WorkboardSessionsBoardView } from "@openclaw/workboard-contract";
import { readStringParam } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import {
  assertNoCursorAdvance,
  createWorkboardDispatchHandler,
  readId,
  readExpectedUpdatedAt,
  registerWorkboardResultMethods,
  respondError,
  WorkboardUploadsDisabledError,
  type GatewayMethodContext,
} from "./gateway-helpers.js";
import {
  registerWorkboardWorkspaceBoardMethod,
  registerWorkboardWorkspaceBulkMethod,
  registerWorkboardWorkspaceCardMethods,
  registerWorkboardWorkspaceWorkflowMethods,
} from "./gateway-workspace-methods.js";
import type { WorkboardSessionsBoardService } from "./sessions-board.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./sqlite-store-paths.js";
import { registerWorkboardStoreLifecycle } from "./store-lifecycle.js";
import { WorkboardStore } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

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

function cardMutation(
  method: string,
  mutate: (id: string, input: Record<string, unknown>) => Promise<WorkboardCard>,
) {
  return [
    `workboard.cards.${method}`,
    WRITE_SCOPE,
    ({ params }: GatewayMethodContext) => redactCardResult(mutate(readId(params), params)),
  ] as const;
}

export function registerWorkboardGatewayMethods(params: {
  api: OpenClawPluginApi;
  store?: WorkboardStore;
  sessionsBoard?: Pick<WorkboardSessionsBoardService, "read" | "update" | "move">;
}) {
  const { api: hostApi } = params;
  const assertUploadsAllowed = (client: GatewayMethodContext["client"]) => {
    if (
      !client?.internal?.syntheticClient &&
      !client?.internal?.agentRuntimeIdentity &&
      hostApi.runtime.config.current().gateway?.uploads?.enabled === false
    ) {
      throw new WorkboardUploadsDisabledError();
    }
  };
  const store =
    params.store ??
    WorkboardStore.openSqlite(resolveWorkboardSqliteWorkerModuleUrl(hostApi.runtimeSource));
  if (!params.store) {
    registerWorkboardStoreLifecycle(hostApi, store);
  }
  const api: OpenClawPluginApi = {
    ...hostApi,
    registerGatewayMethod: (method, handler, options) =>
      hostApi.registerGatewayMethod(
        method,
        async (request) => {
          try {
            return await store.runOperation(() => {
              if (method === "workboard.cards.attachments.add") {
                assertUploadsAllowed(request.client);
              }
              return handler(request);
            });
          } catch (error) {
            respondError(request.respond, error);
          }
        },
        options,
      ),
  };
  const dispatchCards = createWorkboardDispatchHandler({
    api,
    store,
  });

  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.list",
      READ_SCOPE,
      async ({ params: requestParams }) => {
        const result = await store.listCards(requestParams.boardId);
        const since = requestParams.sinceRevision;
        return isRecord(since) &&
          since.epoch === result.revision.epoch &&
          since.revision === result.revision.revision &&
          since.boardId === result.revision.boardId
          ? { unchanged: true, revision: result.revision }
          : result;
      },
    ],
  ]);

  registerWorkboardWorkspaceCardMethods({ api, store });

  api.registerGatewayMethod(
    "workboard.cards.start",
    async (context) => await dispatchCards(context, { supportsMaxStarts: false, directCard: true }),
    { scope: WRITE_SCOPE },
  );

  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.move",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(
          store.move(
            readId(requestParams),
            requestParams.status,
            requestParams.position,
            undefined,
            {
              expectedUpdatedAt: readExpectedUpdatedAt(requestParams),
            },
          ),
        ),
    ],
    [
      "workboard.cards.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        store.delete(readId(requestParams), {
          expectedUpdatedAt: readExpectedUpdatedAt(requestParams),
        }),
    ],
    cardMutation("comment", (id, input) => store.addComment(id, input)),
    cardMutation("link", (id, input) => store.addLink(id, input)),
    [
      "workboard.cards.linkDependency",
      WRITE_SCOPE,
      ({ params: requestParams }) => {
        const parentId = requestParams.parentId;
        const childId = requestParams.childId;
        if (typeof parentId !== "string" || typeof childId !== "string") {
          throw new Error("parentId and childId are required.");
        }
        return redactCardResult(store.linkCards(parentId, childId));
      },
    ],
    cardMutation("proof", (id, input) => store.addProof(id, input)),
    cardMutation("artifact", (id, input) => store.addArtifact(id, input)),
    [
      "workboard.cards.claim",
      WRITE_SCOPE,
      async ({ params: requestParams }) => {
        const claimed = await store.claim(readId(requestParams), requestParams);
        return { ...claimed, card: redactClaimToken(claimed.card) };
      },
    ],
    cardMutation("heartbeat", (id, input) => store.heartbeat(id, input)),
    cardMutation("release", (id, input) => store.releaseClaim(id, input)),
    cardMutation("promote", (id, input) => store.promote(id, input, null)),
    cardMutation("reassign", (id, input) => store.reassign(id, input, null)),
    cardMutation("reclaim", (id, input) => store.reclaim(id, input, null)),
    cardMutation("complete", (id, input) => store.complete(id, input, null)),
    cardMutation("block", (id, input) => store.block(id, input, null)),
    cardMutation("unblock", (id) => store.unblock(id)),
  ]);

  registerWorkboardWorkspaceBulkMethod({ api, store });

  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.diagnostics",
      READ_SCOPE,
      async () => redactDiagnosticsRows(await store.diagnostics()),
    ],
    [
      "workboard.cards.diagnostics.refresh",
      WRITE_SCOPE,
      async () => redactDiagnosticsRows(await store.refreshDiagnostics()),
    ],
  ]);

  api.registerGatewayMethod(
    "workboard.cards.dispatch",
    async (context) => await dispatchCards(context, { supportsMaxStarts: false }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.dispatchWithOptions",
    async (context) => await dispatchCards(context, { supportsMaxStarts: true }),
    { scope: WRITE_SCOPE },
  );

  registerWorkboardResultMethods(api, [
    ["workboard.boards.list", READ_SCOPE, () => store.listBoards()],
  ]);

  registerWorkboardWorkspaceBoardMethod({ api, store });

  const sessionsBoard = () => {
    if (!params.sessionsBoard) {
      throw new Error("Sessions board service is unavailable.");
    }
    return params.sessionsBoard;
  };
  registerWorkboardResultMethods(api, [
    [
      "workboard.sessionsBoard.read",
      READ_SCOPE,
      async (context: GatewayMethodContext) => {
        const result = await sessionsBoard().read(
          readStringParam(context.params, "boardId", { required: true }),
          sessionsBoardView(context.params),
          sessionsBoardCaller(context),
        );
        const since = context.params.sinceRevision;
        return isRecord(since) &&
          result.revision &&
          since.epoch === result.revision.epoch &&
          since.revision === result.revision.revision &&
          since.boardId === result.revision.boardId &&
          since.scope === result.revision.scope
          ? { unchanged: true, revision: result.revision }
          : result;
      },
    ],
    [
      "workboard.sessionsBoard.update",
      WRITE_SCOPE,
      async (context: GatewayMethodContext) => {
        const input = context.params;
        const boardId = readStringParam(input, "boardId", { required: true });
        if (!isRecord(input.patch)) {
          throw new Error("patch must be an object.");
        }
        return {
          board: await sessionsBoard().update(boardId, input.patch, sessionsBoardCaller(context)),
        };
      },
    ],
    [
      "workboard.sessionsBoard.move",
      WRITE_SCOPE,
      (context: GatewayMethodContext) =>
        sessionsBoard().move(
          readStringParam(context.params, "boardId", { required: true }),
          readStringParam(context.params, "sessionKey", { required: true }),
          readStringParam(context.params, "columnId", { required: true }),
          sessionsBoardCaller(context),
        ),
    ],
  ]);

  registerWorkboardResultMethods(api, [
    [
      "workboard.boards.archive",
      WRITE_SCOPE,
      async ({ params: requestParams }) => ({
        board: await store.archiveBoard(requestParams.id, requestParams.archived),
      }),
    ],
    [
      "workboard.boards.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) => store.deleteBoard(requestParams.id),
    ],
    [
      "workboard.cards.stats",
      READ_SCOPE,
      ({ params: requestParams }) => store.stats({ boardId: requestParams.boardId }),
    ],
    [
      "workboard.cards.runs",
      READ_SCOPE,
      async ({ params: requestParams }) => {
        const result = await store.runs(readId(requestParams));
        return { ...result, card: redactClaimToken(result.card) };
      },
    ],
  ]);

  registerWorkboardWorkspaceWorkflowMethods({ api, store });

  registerWorkboardResultMethods(api, [
    [
      "workboard.notifications.subscribe",
      WRITE_SCOPE,
      async ({ params: requestParams }) => ({
        subscription: await store.subscribeNotifications(requestParams),
      }),
    ],
    [
      "workboard.notifications.list",
      READ_SCOPE,
      ({ params: requestParams }) => store.listNotificationSubscriptions(requestParams),
    ],
    [
      "workboard.notifications.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) => store.deleteNotificationSubscription(readId(requestParams)),
    ],
    [
      "workboard.notifications.events",
      READ_SCOPE,
      ({ params: requestParams }) => {
        assertNoCursorAdvance(requestParams);
        return store.notificationEvents(requestParams);
      },
    ],
    [
      "workboard.notifications.advance",
      WRITE_SCOPE,
      ({ params: requestParams }) => store.advanceNotificationEvents(requestParams),
    ],
    [
      "workboard.cards.attachments.list",
      READ_SCOPE,
      async ({ params: requestParams }) => {
        const result = await store.listAttachments(readId(requestParams));
        return { ...result, card: redactClaimToken(result.card) };
      },
    ],
    [
      "workboard.cards.attachments.get",
      READ_SCOPE,
      async ({ params: requestParams }) => {
        const attachment = await store.getAttachment(readId(requestParams));
        if (!attachment) {
          throw new Error(`attachment not found: ${readId(requestParams)}`);
        }
        return attachment;
      },
    ],
    [
      "workboard.cards.attachments.add",
      WRITE_SCOPE,
      ({ params: input, client }: GatewayMethodContext) =>
        redactCardResult(
          store.addAttachment(readId(input), input, undefined, () => assertUploadsAllowed(client)),
        ),
    ],
    [
      "workboard.cards.attachments.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) => {
        const attachmentId = requestParams.attachmentId;
        if (typeof attachmentId !== "string" || !attachmentId.trim()) {
          throw new Error("attachmentId is required.");
        }
        return redactCardResult(store.deleteAttachment(readId(requestParams), attachmentId.trim()));
      },
    ],
    cardMutation("workerLog", (id, input) => store.addWorkerLog(id, input)),
    cardMutation("protocolViolation", (id, input) => store.recordProtocolViolation(id, input)),
    [
      "workboard.cards.archive",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(
          store.archive(readId(requestParams), requestParams.archived, {
            expectedUpdatedAt: readExpectedUpdatedAt(requestParams),
          }),
        ),
    ],
    [
      "workboard.cards.export",
      READ_SCOPE,
      async () => {
        const exported = await store.exportCards();
        return { ...exported, cards: exported.cards.map(redactClaimToken) };
      },
    ],
  ]);
}
