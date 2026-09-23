import type { WorkboardCard } from "@openclaw/workboard-contract";
// Workboard Gateway methods that can persist workspace-bearing card metadata.
import type { OpenClawPluginApi } from "../api.js";
import {
  readId,
  readExpectedUpdatedAt,
  readPatch,
  registerWorkboardResultMethods,
  resolveGatewayWorkboardWorkspaceAccess,
  type GatewayMethodContext,
} from "./gateway-helpers.js";
import type { WorkboardStore } from "./store.js";
import {
  assertWorkboardWorkspaceMutationAccess,
  canonicalizeWorkboardWorkspaceAccess,
  containsWorkboardWorkspaceMutation,
  withWorkboardDecomposeWorkspaceAccess,
  withWorkboardWorkspaceAccess,
  withoutWorkboardWorkspaceAccess,
  type WorkboardWorkspaceAccess,
} from "./workspace-access.js";

const WRITE_SCOPE = "operator.write" as const;

async function resolveGatewayWorkspaceMutationAccess(
  request: GatewayMethodContext,
  value: unknown,
): Promise<WorkboardWorkspaceAccess> {
  const access = await canonicalizeWorkboardWorkspaceAccess(
    resolveGatewayWorkboardWorkspaceAccess({
      context: request.context,
      client: request.client,
    }),
  );
  await assertWorkboardWorkspaceMutationAccess(value, access);
  return access;
}

type WorkspaceGatewayMethodParams = {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  redactCard: (card: WorkboardCard) => WorkboardCard;
};

export function registerWorkboardWorkspaceCardMethods(params: WorkspaceGatewayMethodParams): void {
  const { api, store, redactCard } = params;
  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.create",
      WRITE_SCOPE,
      async (request) => {
        const input = withoutWorkboardWorkspaceAccess(request.params);
        const access = await resolveGatewayWorkspaceMutationAccess(request, input);
        return {
          card: redactCard(await store.create(withWorkboardWorkspaceAccess(input, access))),
        };
      },
    ],
    [
      "workboard.cards.captureSession",
      WRITE_SCOPE,
      async (request) => {
        const input = withoutWorkboardWorkspaceAccess(request.params);
        const access = await resolveGatewayWorkspaceMutationAccess(request, input);
        return {
          card: redactCard(await store.captureSession(withWorkboardWorkspaceAccess(input, access))),
        };
      },
    ],
    [
      "workboard.cards.update",
      WRITE_SCOPE,
      async (request) => {
        const { params: requestParams } = request;
        const patch = withoutWorkboardWorkspaceAccess(readPatch(requestParams));
        const access = await resolveGatewayWorkspaceMutationAccess(request, patch);
        const expectedUpdatedAt = readExpectedUpdatedAt(requestParams);
        return {
          card: redactCard(
            await store.update(
              readId(requestParams),
              containsWorkboardWorkspaceMutation(patch)
                ? withWorkboardWorkspaceAccess(patch, access)
                : patch,
              { expectedUpdatedAt },
            ),
          ),
        };
      },
    ],
  ]);
}

export function registerWorkboardWorkspaceBulkMethod(params: WorkspaceGatewayMethodParams): void {
  const { api, store, redactCard } = params;
  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.bulk",
      WRITE_SCOPE,
      async (request) => {
        const { params: requestParams } = request;
        const sanitizedParams = withoutWorkboardWorkspaceAccess(requestParams);
        const patch = withoutWorkboardWorkspaceAccess(readPatch(requestParams));
        const access = await resolveGatewayWorkspaceMutationAccess(request, patch);
        const result = await store.bulkUpdate({
          ...sanitizedParams,
          patch: containsWorkboardWorkspaceMutation(patch)
            ? withWorkboardWorkspaceAccess(patch, access)
            : patch,
        });
        return { cards: result.cards.map(redactCard) };
      },
    ],
  ]);
}

export function registerWorkboardWorkspaceBoardMethod(params: WorkspaceGatewayMethodParams): void {
  const { api, store } = params;
  registerWorkboardResultMethods(api, [
    [
      "workboard.boards.upsert",
      WRITE_SCOPE,
      async (request) => {
        const { params: requestParams } = request;
        await resolveGatewayWorkspaceMutationAccess(request, requestParams);
        return { board: await store.upsertBoard(requestParams) };
      },
    ],
  ]);
}

export function registerWorkboardWorkspaceWorkflowMethods(
  params: WorkspaceGatewayMethodParams,
): void {
  const { api, store, redactCard } = params;
  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.specify",
      WRITE_SCOPE,
      async (request) => {
        const { params: requestParams } = request;
        const sanitizedParams = withoutWorkboardWorkspaceAccess(requestParams);
        const access = await resolveGatewayWorkspaceMutationAccess(request, sanitizedParams);
        const input = containsWorkboardWorkspaceMutation(sanitizedParams)
          ? withWorkboardWorkspaceAccess(sanitizedParams, access)
          : sanitizedParams;
        return {
          card: redactCard(await store.specify(readId(requestParams), input, null)),
        };
      },
    ],
    [
      "workboard.cards.decompose",
      WRITE_SCOPE,
      async (request) => {
        const { params: requestParams } = request;
        const sanitizedParams = withoutWorkboardWorkspaceAccess(requestParams);
        const access = await resolveGatewayWorkspaceMutationAccess(request, sanitizedParams);
        const result = await store.decompose(
          readId(requestParams),
          withWorkboardDecomposeWorkspaceAccess(sanitizedParams, access),
          null,
        );
        return {
          parent: redactCard(result.parent),
          children: result.children.map(redactCard),
        };
      },
    ],
  ]);
}
