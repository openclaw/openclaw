import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  createLobsterWorkflowStoreFromApi,
  type LobsterWorkflowStore,
} from "./lobster-workflow-store.js";

type RegisterWorkflowGatewayOptions = {
  store?: LobsterWorkflowStore;
};

function stringParam(params: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function objectParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function workflowIdParam(params: Record<string, unknown>): string {
  const workflowId = stringParam(params, "workflowId", "id");
  if (!workflowId) {
    throw new Error("workflowId required");
  }
  return workflowId;
}

function respondError(
  respond: GatewayRequestHandlerOptions["respond"],
  error: unknown,
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes] = ErrorCodes.INVALID_REQUEST,
) {
  const message = error instanceof Error ? error.message : String(error);
  respond(false, undefined, errorShape(code, message));
}

export function registerLobsterWorkflowGatewayMethods(
  api: OpenClawPluginApi,
  options: RegisterWorkflowGatewayOptions = {},
): void {
  const resolveStore = () => options.store ?? createLobsterWorkflowStoreFromApi(api);

  api.registerGatewayMethod(
    "lobster.workflow.publish",
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        const store = resolveStore();
        const record = await store.publish({
          workflowYaml: stringParam(params, "workflowYaml", "document", "yaml") ?? "",
          workflowId: stringParam(params, "workflowId", "id"),
          slug: stringParam(params, "slug"),
          name: stringParam(params, "name"),
          cwd: stringParam(params, "cwd"),
          metadata: objectParam(params, "metadata"),
          overwrite: booleanParam(params, "overwrite"),
        });
        respond(true, { ok: true, workflow: record });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    "lobster.workflow.list",
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        const store = resolveStore();
        const page = await store.list({
          limit: numberParam(params, "limit"),
          cursor: stringParam(params, "cursor"),
          query: stringParam(params, "query"),
        });
        respond(true, { ok: true, ...page });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    "lobster.workflow.get",
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        const store = resolveStore();
        const workflowId = workflowIdParam(params);
        const workflow = await store.get(workflowId, {
          includeDocument: booleanParam(params, "includeDocument"),
        });
        if (!workflow) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workflow not found"));
          return;
        }
        respond(true, { ok: true, workflow });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    "lobster.workflow.delete",
    async ({ params, respond }: GatewayRequestHandlerOptions) => {
      try {
        const store = resolveStore();
        const result = await store.delete(workflowIdParam(params), {
          expectedRevision: numberParam(params, "expectedRevision"),
        });
        respond(true, { ok: true, ...result });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: "operator.write" },
  );
}
