import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createCodexNativeHookRelay } from "./src/app-server/native-hook-relay.js";
import { resolveCodexNativeModelInputTools } from "./src/app-server/native-model-input-tools.js";

export function createCodexNativeSpawnRelayForTest(params: {
  hostCapabilities: EmbeddedRunAttemptParamsV2["hostCapabilities"];
  runId: string;
  sessionKey: string;
  namespace: string;
}) {
  const relay = createCodexNativeHookRelay({
    options: { enabled: true },
    events: ["pre_tool_use"],
    agentId: "main",
    sessionId: params.runId,
    sessionKey: params.sessionKey,
    config: {},
    runId: params.runId,
    attemptTimeoutMs: 30_000,
    startupTimeoutMs: 1_000,
    turnStartTimeoutMs: 1_000,
    loopDetectionPreToolUseRelay: false,
    signal: new AbortController().signal,
    hostCapabilities: params.hostCapabilities,
    nativeModelAdmission: {
      client: () => {
        throw new Error("Spawn admission must precede a native child request");
      },
      threadId: () => "parent-thread",
      tools: resolveCodexNativeModelInputTools({
        features: { multi_agent_v2: { tool_namespace: params.namespace } },
      }),
      readQualification: () => undefined,
    },
    onPreToolUseFailure: () => {},
  });
  if (!relay) {
    throw new Error("Expected native spawn admission relay");
  }
  return relay;
}
