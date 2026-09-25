import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareAttemptSessionFixture(
  attempt: Omit<EmbeddedRunAttemptParams, "admittedRunContext">,
) {
  const target = attempt.sessionTarget;
  if (!target?.storePath || !attempt.sessionKey) {
    throw new Error("Embedded attempt fixture requires its canonical session target");
  }
  attempt.config = {
    ...attempt.config,
    session: { ...attempt.config?.session, store: target.storePath },
  };
  const { upsertSessionEntryCore } =
    await import("../../../config/sessions/session-accessor.entry.js");
  await upsertSessionEntryCore(
    { agentId: target.agentId, storePath: target.storePath, sessionKey: attempt.sessionKey },
    { sessionId: attempt.sessionId, updatedAt: 1 },
  );
}

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
    prepStages: createEmbeddedRunStageTracker(),
    proactiveSubagentOrchestration: false,
    ...overrides,
  };
}
