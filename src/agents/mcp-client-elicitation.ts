import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { assertionSucceeds } from "../shared/assertion.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";

export const MCP_ELICITATION_TIMEOUT_MS = 600_000;

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
      { ProtocolError, ProtocolErrorCode },
    ] = await Promise.all([
      import("./harness/structured-input.js"),
      import("./harness/structured-input-execution.js"),
      import("@modelcontextprotocol/client"),
    ]);
    params.assertCurrent();
    const rich = request.method === "openai/elicitation/create";
    const value = snapshotStructuredInput(request.params, { richForm: rich });
    if (!isStructuredInputRecord(value)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Malformed MCP elicitation request");
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
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, input.message);
      }
      const result = await runStructuredInput({
        input,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        timeoutMs: MCP_ELICITATION_TIMEOUT_MS,
        delivery: {},
        gatewayCall: params.gatewayCall,
        signal: request.signal,
        isActive: () => assertionSucceeds(() => params.assertCurrent()),
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
