import { vi } from "vitest";

export function createTestThinkingPolicy(state: {
  isThinkingLevelSupportedMock: (args: unknown) => boolean;
  resolveSupportedThinkingLevelMock: (args: { level?: string }) => string | undefined;
  resolveThinkingDefaultMock: (args: unknown) => string;
}) {
  return {
    formatThinkingLevels: () => "low, medium, high",
    normalizeThinkLevel: (v?: string) => v || undefined,
    normalizeVerboseLevel: (v?: string) => v || undefined,
    isThinkingLevelSupported: (args: unknown) => state.isThinkingLevelSupportedMock(args),
    resolveSupportedThinkingLevel: (args: { level?: string }) =>
      state.resolveSupportedThinkingLevelMock(args),
    resolveThinkingSelectionForModel: (args: { level?: string }) => {
      const requestedLevel = args.level ?? state.resolveThinkingDefaultMock(args);
      const policy = { ...args, level: requestedLevel };
      return {
        requestedLevel,
        level: state.resolveSupportedThinkingLevelMock(policy),
        supported: state.isThinkingLevelSupportedMock(policy),
      };
    },
    supportsXHighThinking: () => false,
  };
}

export function createTestAgentScope(
  params: {
    hasLegacyAutoFallbackWithoutOriginMock: (entry: unknown) => boolean;
    resolveAutoFallbackPrimaryProbeMock: (params: unknown) => unknown;
    resolveEffectiveModelFallbacksMock: (...args: unknown[]) => unknown;
  },
  native: Pick<
    typeof import("./agent-scope.js"),
    "resolveAgentModelFallbacksOverride" | "resolveSubagentSpawnModelFallbacksOverride"
  >,
) {
  return {
    resolveAgentModelFallbacksOverride: native.resolveAgentModelFallbacksOverride,
    resolveSubagentSpawnModelFallbacksOverride: native.resolveSubagentSpawnModelFallbacksOverride,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => true,
    hasLegacyAutoFallbackWithoutOrigin: (entry: unknown) =>
      params.hasLegacyAutoFallbackWithoutOriginMock(entry),
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentEntries: () => [],
    listAgentIds: () => ["default"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: (args: unknown) =>
      params.resolveAutoFallbackPrimaryProbeMock(args),
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => "/tmp/agent",
    resolveAgentEffectiveModelPrimary: (cfg: unknown) => {
      const raw = (cfg as { agents?: { defaults?: { model?: string | { primary?: string } } } })
        ?.agents?.defaults?.model;
      return typeof raw === "string" ? raw : raw?.primary;
    },
    resolveDefaultAgentId: () => "default",
    resolveEffectiveModelFallbacks: params.resolveEffectiveModelFallbacksMock,
    resolveSessionAgentIds: () => ({ defaultAgentId: "default", sessionAgentId: "default" }),
    resolveSessionAgentId: () => "default",
    resolveAgentSkillsFilter: () => undefined,
    resolveAgentWorkspaceDir: () => "/tmp/workspace",
  };
}

export function createTestRuntimePlugins(
  createEmptyPluginRegistry: typeof import("../plugins/registry-empty.js").createEmptyPluginRegistry,
) {
  return {
    withAgentPluginRegistry: ({ run }: { run: () => unknown }) => run(),
    loadAgentRuntimePluginRegistryHandle: () => createEmptyPluginRegistry(),
    acquireAgentRuntimePluginRegistry: async () => {
      const registry = createEmptyPluginRegistry();
      return { registry, primaryRegistry: registry };
    },
  };
}
