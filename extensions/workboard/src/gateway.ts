import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import {
  assertNoCursorAdvance,
  createWorkboardDispatchHandler,
  listWorkboardCards,
  readId,
  readExpectedUpdatedAt,
  registerWorkboardResultMethods,
  respondError,
  type GatewayMethodContext,
} from "./gateway-helpers.js";
import {
  registerWorkboardWorkspaceBoardMethod,
  registerWorkboardWorkspaceBulkMethod,
  registerWorkboardWorkspaceCardMethods,
  registerWorkboardWorkspaceWorkflowMethods,
} from "./gateway-workspace-methods.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./sqlite-store-paths.js";
import { registerWorkboardStoreLifecycle } from "./store-lifecycle.js";
import { WorkboardStore } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

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
}) {
  const { api: hostApi } = params;
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
            return await store.runOperation(() => handler(request));
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
    redactCard: redactClaimToken,
  });

  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.list",
      READ_SCOPE,
      async ({ params: requestParams }) =>
        await listWorkboardCards(store, requestParams.boardId, redactClaimToken),
    ],
  ]);

  registerWorkboardWorkspaceCardMethods({ api, store, redactCard: redactClaimToken });

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

  registerWorkboardWorkspaceBulkMethod({ api, store, redactCard: redactClaimToken });

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

  registerWorkboardWorkspaceBoardMethod({ api, store, redactCard: redactClaimToken });

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

  registerWorkboardWorkspaceWorkflowMethods({ api, store, redactCard: redactClaimToken });

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
    cardMutation("attachments.add", (id, input) => store.addAttachment(id, input)),
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
