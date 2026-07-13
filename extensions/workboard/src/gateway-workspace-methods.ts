// Workboard Gateway methods that can persist workspace-bearing card metadata.
import type { OpenClawPluginApi } from "../api.js";
import {
  readId,
  readPatch,
  resolveGatewayWorkboardWorkspaceAccess,
  respondError,
  type GatewayMethodContext,
} from "./gateway-helpers.js";
import type { WorkboardStore } from "./store.js";
import type { WorkboardCard } from "./types.js";
import { assertWorkboardWorkspaceMutationAccess } from "./workspace-access.js";

const WRITE_SCOPE = "operator.write" as const;

async function assertGatewayWorkspaceMutation(
  request: GatewayMethodContext,
  value: unknown,
): Promise<void> {
  await assertWorkboardWorkspaceMutationAccess(
    value,
    resolveGatewayWorkboardWorkspaceAccess({
      context: request.context,
      client: request.client,
    }),
  );
}

type WorkspaceGatewayMethodParams = {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  redactCard: (card: WorkboardCard) => WorkboardCard;
};

export function registerWorkboardWorkspaceCardMethods(params: WorkspaceGatewayMethodParams): void {
  const { api, store, redactCard } = params;
  api.registerGatewayMethod(
    "workboard.cards.create",
    async (request) => {
      const { params: requestParams, respond } = request;
      try {
        await assertGatewayWorkspaceMutation(request, requestParams);
        respond(true, { card: redactCard(await store.create(requestParams)) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.update",
    async (request) => {
      const { params: requestParams, respond } = request;
      try {
        const patch = readPatch(requestParams);
        await assertGatewayWorkspaceMutation(request, patch);
        respond(true, { card: redactCard(await store.update(readId(requestParams), patch)) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardWorkspaceBulkMethod(params: WorkspaceGatewayMethodParams): void {
  const { api, store, redactCard } = params;
  api.registerGatewayMethod(
    "workboard.cards.bulk",
    async (request) => {
      const { params: requestParams, respond } = request;
      try {
        await assertGatewayWorkspaceMutation(request, requestParams);
        const result = await store.bulkUpdate(requestParams);
        respond(true, { cards: result.cards.map(redactCard) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardWorkspaceBoardMethod(params: WorkspaceGatewayMethodParams): void {
  const { api, store } = params;
  api.registerGatewayMethod(
    "workboard.boards.upsert",
    async (request) => {
      const { params: requestParams, respond } = request;
      try {
        await assertGatewayWorkspaceMutation(request, requestParams);
        respond(true, { board: await store.upsertBoard(requestParams) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardWorkspaceWorkflowMethods(
  params: WorkspaceGatewayMethodParams,
): void {
  const { api, store, redactCard } = params;
  api.registerGatewayMethod(
    "workboard.cards.specify",
    async (request) => {
      const { params: requestParams, respond } = request;
      try {
        await assertGatewayWorkspaceMutation(request, requestParams);
        respond(true, {
          card: redactCard(await store.specify(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.decompose",
    async (request) => {
      const { params: requestParams, respond } = request;
      try {
        await assertGatewayWorkspaceMutation(request, requestParams);
        const result = await store.decompose(readId(requestParams), requestParams, null);
        respond(true, {
          parent: redactCard(result.parent),
          children: result.children.map(redactCard),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
