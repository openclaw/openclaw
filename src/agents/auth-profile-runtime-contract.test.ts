// Attempt composition lives in command/attempt-execution.cli.test.ts; keep this matrix runtime-free.
import {
  AUTH_PROFILE_RUNTIME_CONTRACT as contract,
  createAuthAliasManifestRegistry,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { configFor } from "./model-auth.fixtures.test-support.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "./runtime-plan/auth.js";

const pluginMetadataMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(() => undefined),
  loadPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

const workspaceDir = "/tmp/openclaw-auth-contract";
const authAliasMetadata = {
  plugins: createAuthAliasManifestRegistry().plugins,
};

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return configFor(provider, "https://api.openclaw.test/v1", {
    agentRuntime: { id: runtime },
  });
}

describe("Auth profile runtime contract - embedded OpenClaw and CLI adapter", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    pluginMetadataMocks.getCurrentPluginMetadataSnapshot.mockClear();
    pluginMetadataMocks.loadPluginMetadataSnapshot.mockReset().mockReturnValue(authAliasMetadata);
  });

  it.each([
    [contract.openAiProvider, contract.openAiProvider],
    [contract.codexCliProvider, contract.openAiProvider],
    [contract.codexHarnessProvider, contract.codexHarnessProvider],
  ] as const)(
    "resolves %s through the provider auth alias resolver using contract metadata",
    (provider, expectedAuthProvider) => {
      expect(resolveProviderIdForAuth(provider, { config: {}, workspaceDir })).toBe(
        expectedAuthProvider,
      );
    },
  );

  const {
    openAiProvider: openai,
    codexCliProvider: cli,
    openAiCodexProvider: legacy,
    codexHarnessProvider: harness,
    openAiProfileId: profile,
    openAiCodexProfileId: legacyProfile,
  } = contract;
  type PlanOptions = {
    config?: OpenClawConfig;
    runtime?: string;
    source?: "user";
    rejected?: boolean;
  };
  const codexConfig = providerRuntimeConfig(openai, "codex");
  it.each<[string, string, string, string, PlanOptions?]>([
    ["legacy profile via CLI alias", cli, cli, legacyProfile],
    ["OpenAI profile via CLI", cli, openai, profile],
    [
      "unrelated CLI rejects Codex auth",
      contract.claudeCliProvider,
      legacy,
      legacyProfile,
      { config: codexConfig, rejected: true },
    ],
    ["embedded legacy profile", legacy, legacy, legacyProfile],
    ["embedded CLI alias", legacy, cli, legacyProfile],
    [
      "explicit OpenClaw",
      openai,
      openai,
      profile,
      { config: providerRuntimeConfig(openai, "openclaw"), runtime: "openclaw" },
    ],
    ["default Codex harness", openai, legacy, legacyProfile, { runtime: "codex" }],
    [
      "codex/* harness",
      harness,
      legacy,
      legacyProfile,
      { config: providerRuntimeConfig(harness, "codex"), runtime: "codex" },
    ],
    [
      "locked profile source",
      openai,
      legacy,
      legacyProfile,
      { config: codexConfig, runtime: "codex", source: "user" },
    ],
  ])("forwards auth: %s", (_name, provider, auth, profileId, options = {}) => {
    const plan = buildAgentRuntimeAuthPlan({
      provider,
      authProfileProvider: auth,
      sessionAuthProfileId: profileId,
      sessionAuthProfileSource: options.source,
      config: options.config ?? {},
      workspaceDir,
      harnessRuntime: options.runtime,
    });
    expect(plan.forwardedAuthProfileId).toBe(options.rejected ? undefined : profileId);
    if (options.source) {
      expect(plan.forwardedAuthProfileSource).toBe(options.source);
    }
  });
});
