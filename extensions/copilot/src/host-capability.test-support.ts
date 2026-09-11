import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

type TestHostCapabilities = NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]>;
type TranscriptCapableTestHostCapabilities = TestHostCapabilities &
  Readonly<{
    commitProviderTranscriptPrefix: NonNullable<
      TestHostCapabilities["commitProviderTranscriptPrefix"]
    >;
  }>;

/** Host authority that intentionally omits the optional provider transcript commit capability. */
export function createCopilotHostCapabilitiesWithoutTranscriptCommit(): TestHostCapabilities {
  return Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
  });
}

/** Minimal host authority for tests that do not exercise host policy or approvals. */
export function createCopilotTestHostCapabilities(): TranscriptCapableTestHostCapabilities {
  const commitProviderTranscriptPrefix: NonNullable<
    TestHostCapabilities["commitProviderTranscriptPrefix"]
  > = async () => ({
    kind: "rejected",
    reason: "test host transcript commit is not configured",
  });
  return Object.freeze({
    ...createCopilotHostCapabilitiesWithoutTranscriptCommit(),
    createToolSurface: (options) => createOpenClawCodingTools(options),
    commitProviderTranscriptPrefix,
  });
}

/** Transcript-capable host before the optional host tool constructor is available. */
export function createCopilotConstructorlessTestHostCapabilities(): TranscriptCapableTestHostCapabilities {
  const { createToolSurface: _createToolSurface, ...hostCapabilities } =
    createCopilotTestHostCapabilities();
  return Object.freeze(hostCapabilities);
}
