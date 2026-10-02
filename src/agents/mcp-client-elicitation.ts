import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";

export type McpElicitationHandler = (request: {
  method: "elicitation/create" | "openai/elicitation/create";
  requestId?: string | number;
  params: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}>;
const handlers = resolveGlobalSingleton(
  Symbol.for("openclaw.mcpElicitationHandler"),
  () => new AsyncLocalStorage<McpElicitationHandler>(),
);
export function runWithMcpElicitationHandler<T>(handler: McpElicitationHandler, run: () => T): T {
  return handlers.run(handler, run);
}
/** Capture the current tool caller for harness-native, out-of-band requests. */
export function captureMcpClientElicitation() {
  const handler = handlers.getStore();
  if (!handler) {
    return undefined;
  }
  const restore = AsyncLocalStorage.snapshot();
  return {
    signal: getSessionMcpRequestSignal(),
    handle: (request: Parameters<McpElicitationHandler>[0]) => restore(handler, request),
  };
}

/** The SDK transport callback does not inherit the calling tool's async scope. */
export function bindMcpClientElicitation(client: Client) {
  const active = new Set<{ handler?: McpElicitationHandler; signal: AbortSignal }>();
  for (const method of ["elicitation/create", "openai/elicitation/create"] as const) {
    const schema = z.object({
      method: z.literal(method),
      params: z.record(z.string(), z.unknown()),
    });
    client.setRequestHandler(schema, async (request, extra) => {
      // MCP 2025-11-25 does not carry a portable parent-call id. Never route a
      // server question to a different collaborator when requests overlap.
      const call = active.size === 1 ? active.values().next().value : undefined;
      if (!call?.handler) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "MCP elicitation has no unambiguous active requester",
        );
      }
      const signal = AbortSignal.any([call.signal, extra.signal]);
      signal.throwIfAborted();
      const result = await call.handler({
        method,
        requestId: extra.requestId,
        params: request.params,
        signal,
      });
      signal.throwIfAborted();
      if (!active.has(call)) {
        throw new McpError(ErrorCode.InvalidRequest, "MCP elicitation requester expired");
      }
      return result;
    });
  }
  return async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    const handler = handlers.getStore();
    const restoreCaller = AsyncLocalStorage.snapshot();
    const call = {
      handler: handler
        ? (request: Parameters<McpElicitationHandler>[0]) => restoreCaller(handler, request)
        : undefined,
      signal,
    };
    active.add(call);
    try {
      return await run();
    } finally {
      active.delete(call);
    }
  };
}

/** Transport adapter only: the shared structured-input compiler owns form semantics. */
export function createMcpClientElicitationHandler(params: {
  sessionKey: string;
  agentId?: string;
  assertCurrent: () => void;
  gatewayCall?:
    | import("./harness/gateway-question-dispatch.js").AgentHarnessQuestionGatewayCall
    | import("./harness/gateway-question-dispatch.js").AgentQuestionDispatcher;
  prepareResourceContext?: (request: {
    requestId: string | number;
    snapshot: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<{
    context: import("./harness/structured-input-boundary.js").StructuredInputResourceContext;
    dispose: () => void | Promise<void>;
  }>;
}): McpElicitationHandler {
  return async (request) => {
    params.assertCurrent();
    const [
      {
        compileStructuredInputForm,
        compileStructuredInputUrl,
        snapshotStructuredInput,
        isStructuredInputRecord,
      },
      { runStructuredInput },
    ] = await Promise.all([
      import("./harness/structured-input.js"),
      import("./harness/structured-input-execution.js"),
    ]);
    params.assertCurrent();
    const rich = request.method === "openai/elicitation/create";
    const value = snapshotStructuredInput(request.params, { richForm: rich });
    if (!isStructuredInputRecord(value)) {
      throw new McpError(ErrorCode.InvalidParams, "Malformed MCP elicitation request");
    }
    const resource =
      rich && params.prepareResourceContext && value.mode !== "url"
        ? await params.prepareResourceContext({
            requestId: request.requestId ?? randomUUID(),
            snapshot: value,
            signal: request.signal,
          })
        : undefined;
    try {
      const input =
        value.mode === "url"
          ? compileStructuredInputUrl({
              url: value.url,
              elicitationId: value.elicitationId,
              message: value.message,
              fallbackMessage: "MCP server needs input",
              protocolName: "MCP",
            })
          : compileStructuredInputForm({
              schema: value.requestedSchema,
              message: typeof value.message === "string" ? value.message : undefined,
              fallbackMessage: "MCP server needs input",
              options: {
                protocolName: rich ? "OpenAI" : "MCP",
                allowRichForms: rich,
                ...(resource ? { resourceContext: resource.context } : {}),
                allowEmptyForm: true,
                minimumChoiceCount: 1,
                allowEnumNames: true,
                metadata: { secretPath: ["isSecret"] },
              },
            });
      if (input.kind === "unsupported") {
        throw new McpError(ErrorCode.InvalidParams, input.message);
      }
      const result = await runStructuredInput({
        input,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        timeoutMs: 120_000,
        delivery: {},
        gatewayCall: params.gatewayCall,
        signal: request.signal,
        isActive: () => {
          try {
            params.assertCurrent();
            return true;
          } catch {
            return false;
          }
        },
      });
      params.assertCurrent();
      return result.status === "answered"
        ? { action: "accept", content: result.content }
        : {
            action:
              result.status === "declined" || result.status === "unsupported"
                ? "decline"
                : "cancel",
          };
    } finally {
      await resource?.dispose();
    }
  };
}
