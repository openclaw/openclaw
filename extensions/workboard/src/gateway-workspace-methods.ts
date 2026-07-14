import type { OpenClawPluginApi } from "../api.js";
import { readId, readPatch, respondError } from "./gateway-helpers.js";
import type { WorkboardStore } from "./store.js";
import type { WorkboardCard } from "./types.js";
import { resolveManagedWorktreeSourceAuthorization as workspaceAuth } from "./workspace-authorization.js";

type RegistrationParams = {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  redactCard: (card: WorkboardCard) => WorkboardCard;
};

const WRITE_SCOPE = "operator.write" as const;

export function registerWorkboardCardCreateMethod(params: RegistrationParams) {
  params.api.registerGatewayMethod(
    "workboard.cards.create",
    async ({ params: requestParams, respond, client }) => {
      try {
        respond(true, {
          card: params.redactCard(
            await params.store.create(requestParams, undefined, workspaceAuth(client)),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardCardUpdateMethod(params: RegistrationParams) {
  params.api.registerGatewayMethod(
    "workboard.cards.update",
    async ({ params: requestParams, respond, client }) => {
      try {
        respond(true, {
          card: params.redactCard(
            await params.store.update(
              readId(requestParams),
              readPatch(requestParams),
              workspaceAuth(client),
            ),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardCardBulkMethod(params: RegistrationParams) {
  params.api.registerGatewayMethod(
    "workboard.cards.bulk",
    async ({ params: requestParams, respond, client }) => {
      try {
        const result = await params.store.bulkUpdate(requestParams, workspaceAuth(client));
        respond(true, { cards: result.cards.map(params.redactCard) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardBoardUpsertMethod(params: RegistrationParams) {
  params.api.registerGatewayMethod(
    "workboard.boards.upsert",
    async ({ params: requestParams, respond, client }) => {
      try {
        respond(true, {
          board: await params.store.upsertBoard(requestParams, workspaceAuth(client)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardCardSpecifyMethod(params: RegistrationParams) {
  params.api.registerGatewayMethod(
    "workboard.cards.specify",
    async ({ params: requestParams, respond, client }) => {
      try {
        respond(true, {
          card: params.redactCard(
            await params.store.specify(
              readId(requestParams),
              requestParams,
              null,
              workspaceAuth(client),
            ),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}

export function registerWorkboardCardDecomposeMethod(params: RegistrationParams) {
  params.api.registerGatewayMethod(
    "workboard.cards.decompose",
    async ({ params: requestParams, respond, client }) => {
      try {
        const result = await params.store.decompose(
          readId(requestParams),
          requestParams,
          null,
          workspaceAuth(client),
        );
        respond(true, {
          parent: params.redactCard(result.parent),
          children: result.children.map(params.redactCard),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
