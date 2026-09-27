import { createCodexDynamicToolBridge as createBridge } from "./dynamic-tools.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";

export function createReportedCodexTestBridge(params: Parameters<typeof createBridge>[0]) {
  return createBridge({
    ...params,
    bindToolExecution: createCodexTestHostCapabilities(
      {},
      {
        runId: params.hookContext?.runId ?? "run-1",
        sessionId: params.hookContext?.sessionId ?? "session-1",
        agentId: params.hookContext?.agentId,
        sessionKey: params.hookContext?.sessionKey,
      },
    ).bindToolExecution,
  });
}
