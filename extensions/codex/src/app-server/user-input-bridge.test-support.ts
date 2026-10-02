import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";

let sequence = 0;

export function createCodexUserInputTestParams(signal?: AbortSignal): EmbeddedRunAttemptParams {
  sequence += 1;
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    sessionId: `session-${sequence}`,
    sessionKey: `agent:main:session-${sequence}`,
    agentId: "main",
    timeoutMs: 90_000,
    onBlockReply: vi.fn(),
    onAgentEvent: vi.fn(),
    abortSignal: signal,
  } as unknown as EmbeddedRunAttemptParams;
}
