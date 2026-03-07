import type {
  ContinuityKind,
  ContinuityPatchAction,
  ContinuityReviewState,
  ContinuityService,
  ContinuitySourceClass,
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/continuity";
import {
  ContinuityContextEngine,
  ErrorCodes,
  createContinuityService,
  errorShape,
  registerContinuityCli,
  resolveContinuityConfig,
} from "openclaw/plugin-sdk/continuity";

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readOptionalPositiveInt(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function readStateFilter(
  params: Record<string, unknown>,
): ContinuityReviewState | "all" | undefined {
  const value = readOptionalString(params, "state");
  return value === "pending" || value === "approved" || value === "rejected" || value === "all"
    ? value
    : undefined;
}

function readKindFilter(params: Record<string, unknown>): ContinuityKind | "all" | undefined {
  const value = readOptionalString(params, "kind");
  return value === "fact" ||
    value === "preference" ||
    value === "decision" ||
    value === "open_loop" ||
    value === "all"
    ? value
    : undefined;
}

function readSourceFilter(
  params: Record<string, unknown>,
): ContinuitySourceClass | "all" | undefined {
  const value = readOptionalString(params, "sourceClass");
  return value === "main_direct" ||
    value === "paired_direct" ||
    value === "group" ||
    value === "channel" ||
    value === "all"
    ? value
    : undefined;
}

function readPatchAction(params: Record<string, unknown>): ContinuityPatchAction | undefined {
  const value = readOptionalString(params, "action");
  return value === "approve" || value === "reject" || value === "remove" ? value : undefined;
}

function sendInvalid(respond: GatewayRequestHandlerOptions["respond"], message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

const plugin = {
  id: "continuity",
  name: "Continuity",
  description: "Cross-channel continuity capture, review, and recall for direct chats.",
  kind: "context-engine",
  register(api: OpenClawPluginApi) {
    const pluginConfig = resolveContinuityConfig(api.pluginConfig);
    let service: ContinuityService | null = null;

    const ensureService = (): ContinuityService => {
      service ??= createContinuityService(api.config, pluginConfig);
      return service;
    };

    api.registerContextEngine("continuity", () => new ContinuityContextEngine(ensureService()));

    api.registerGatewayMethod(
      "continuity.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const status = await ensureService().status(readOptionalString(params, "agentId"));
          respond(true, status);
        } catch (err) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
        }
      },
    );

    api.registerGatewayMethod(
      "continuity.list",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const records = await ensureService().list({
            agentId: readOptionalString(params, "agentId"),
            filters: {
              state: readStateFilter(params),
              kind: readKindFilter(params),
              sourceClass: readSourceFilter(params),
              limit: readOptionalPositiveInt(params, "limit"),
            },
          });
          respond(true, records);
        } catch (err) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
        }
      },
    );

    api.registerGatewayMethod(
      "continuity.patch",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        const id = readOptionalString(params, "id");
        const action = readPatchAction(params);
        if (!id || !action) {
          sendInvalid(respond, "id and action required");
          return;
        }
        try {
          const result = await ensureService().patch({
            agentId: readOptionalString(params, "agentId"),
            id,
            action,
          });
          if (!result.ok) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, `unknown continuity id: ${id}`),
            );
            return;
          }
          respond(true, result);
        } catch (err) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
        }
      },
    );

    api.registerGatewayMethod(
      "continuity.explain",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        const id = readOptionalString(params, "id");
        if (!id) {
          sendInvalid(respond, "id required");
          return;
        }
        try {
          const result = await ensureService().explain({
            agentId: readOptionalString(params, "agentId"),
            id,
          });
          if (!result) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, `unknown continuity id: ${id}`),
            );
            return;
          }
          respond(true, result);
        } catch (err) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
        }
      },
    );

    api.registerCli(
      ({ program }) => {
        registerContinuityCli({
          program,
          ensureService,
        });
      },
      { commands: ["continuity"] },
    );
  },
};

export default plugin;
