import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { createAgentHarnessToolExecutionRegistry } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolCallParams, JsonValue } from "./protocol.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";

/** Real request controller and executable bridge; no model, network, or transcript fixture. */
export function createCodexToolOutcomeFixture(params: {
  tool: AnyAgentTool;
  hookContext: NonNullable<Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"]>;
  controller?: AbortController;
}) {
  const controller = params.controller ?? new AbortController();
  const toolBridge = createCodexDynamicToolBridge({
    tools: [params.tool],
    signal: controller.signal,
    hookContext: params.hookContext,
  });
  // Only server-request fields are populated. Other attempt owners are deliberately
  // absent: this fixture exercises the registered request path, not native startup.
  const resources = {
    prompt: {
      context: {
        runtime: {
          connection: {
            params: params.hookContext,
            computerUseConfig: { enabled: false },
            runAbortController: controller,
            appServer: resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null }),
            sessionAgentId: params.hookContext.agentId,
          },
        },
        attemptTools: {
          compactionPlanState: {},
          toolBridge,
          toolOutcomeOrdinals: new Map<string, number>(),
          suppressedDynamicToolOutcomeOrdinals: new Set<number>(),
        },
      },
    },
    state: { thread: { threadId: "thread-outcome" } },
    projectorRef: {},
  } as Parameters<typeof createCodexAttemptServerRequestController>[0];
  const turnRuntime = {
    state: { activeAppServerTurnRequests: 0, currentTurnHadNonTerminalDynamicToolResult: false },
    steeringQueueRef: {},
    async interruptTurn() {
      throw new Error("Unexpected native interrupt in source outcome fixture");
    },
    completeTurn() {
      throw new Error("Unexpected native completion in source outcome fixture");
    },
    turnIdRef: { current: "turn-outcome" },
    userInputBridgeRef: {},
    openClawDynamicToolExecutions: createAgentHarnessToolExecutionRegistry<
      Pick<CodexDynamicToolCallParams, "threadId" | "turnId" | "callId">,
      CodexDynamicToolRuntimeResponse
    >((call) => [call.threadId, call.turnId, call.callId]),
    pendingOpenClawDynamicToolCompletionIds: new Set<string>(),
    noteProgress() {},
  } satisfies Parameters<typeof createCodexAttemptServerRequestController>[1];
  const lifecycle = {
    emitExecutionPhaseOnce() {},
    scheduleTurnReleaseAfterTerminalDynamicTool() {},
    scheduleTerminalDynamicToolReleaseCheck() {},
  } satisfies Parameters<typeof createCodexAttemptServerRequestController>[2];
  const requests = createCodexAttemptServerRequestController(
    resources,
    turnRuntime,
    lifecycle,
    async () => {},
  );
  return {
    async call(args: JsonValue, callId = "call-outcome") {
      return await requests.handleServerRequest(
        {
          id: callId,
          method: "item/tool/call",
          params: {
            threadId: "thread-outcome",
            turnId: "turn-outcome",
            callId,
            namespace: null,
            tool: params.tool.name,
            arguments: args,
          },
        },
        { threadId: "thread-outcome", turnId: "turn-outcome" },
      );
    },
  };
}
