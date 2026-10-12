import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";

export function createAttemptSetupFixture(
  overrides: Partial<EmbeddedAttemptSetup> = {},
): EmbeddedAttemptSetup {
  return {
    agentCoreThinkingLevel: "off",
    providerThinkingLevel: undefined,
    effectiveCwd: "/tmp/workspace",
    effectiveWorkspace: "/tmp/workspace",
    effectiveFsWorkspaceOnly: false,
    resolvedWorkspace: "/tmp/workspace",
    sessionPermissionRoot: "/tmp/workspace",
    sessionPermissionPolicy: undefined,
    sandbox: null,
    sandboxReport: { mode: "off", sandboxed: false },
    sandboxSessionKey: "session",
    sessionAgentId: "main",
    emitCorePluginToolStageSummary: () => {},
    emitPrepStageSummary: () => {},
    getCurrentAttemptPluginMetadataSnapshot: () => undefined,
    getProviderRuntimeHandle: () => ({
      provider: "provider",
      modelId: "model",
      workspaceDir: "/tmp/workspace",
      prepared: true,
    }),
    prepStages: createStageTimingTracker(Date.now),
    proactiveSubagentOrchestration: false,
    ...overrides,
  };
}
