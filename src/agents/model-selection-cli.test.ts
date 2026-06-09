// Verifies model-selection CLI provider detection from plugin metadata.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  clearCurrentPluginMetadataSnapshot,
  resolvePluginMetadataControlPlaneFingerprint,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { testing as setupRegistryRuntimeTesting } from "../plugins/setup-registry.runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles.js";
import {
  classifyAuthCredentialIntegration,
  isCliProvider,
  resolveModelIntegrationLabel,
  resolveProviderAuthIntegrationLabel,
} from "./model-selection-cli.js";

const authProfilesMocks = vi.hoisted(() => ({
  loadAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
}));

const orderMocks = vi.hoisted(() => ({
  isStoredCredentialCompatibleWithAuthProvider: vi.fn(() => true),
}));

vi.mock("./auth-profiles.js", () => ({
  loadAuthProfileStoreWithoutExternalProfiles:
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder: authProfilesMocks.resolveAuthProfileOrder,
}));

vi.mock("./auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider:
    orderMocks.isStoredCredentialCompatibleWithAuthProvider,
}));

function buildStore(profiles: Record<string, AuthProfileCredential>): AuthProfileStore {
  return { profiles, order: {} } as unknown as AuthProfileStore;
}

function setCliBackendMetadataSnapshot(cliBackends: string[]) {
  // Builds a minimal current plugin metadata snapshot so isCliProvider can use
  // descriptor metadata without loading setup runtime modules.
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test-host",
    compatRegistryVersion: "test-compat",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [
      {
        pluginId: "anthropic",
        manifestPath: "/tmp/anthropic/openclaw.plugin.json",
        manifestHash: "test-manifest",
        source: "/tmp/anthropic/index.ts",
        rootDir: "/tmp/anthropic",
        origin: "bundled",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
  };
  const snapshot = {
    policyHash,
    configFingerprint: resolvePluginMetadataControlPlaneFingerprint(
      {},
      {
        env: process.env,
        index,
        policyHash,
      },
    ),
    index,
    plugins: [
      {
        id: "anthropic",
        origin: "bundled",
        cliBackends,
      },
    ],
  } as unknown as PluginMetadataSnapshot;
  setCurrentPluginMetadataSnapshot(snapshot, { config: {}, env: process.env });
}

describe("isCliProvider", () => {
  beforeEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
    setCliBackendMetadataSnapshot(["claude-cli"]);
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    setupRegistryRuntimeTesting.resetRuntimeState();
  });

  it("returns true for setup-registered cli backends", () => {
    expect(isCliProvider("claude-cli", {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for provider ids", () => {
    expect(isCliProvider("example-cli", {} as OpenClawConfig)).toBe(false);
  });

  it("does not execute setup runtime when descriptor metadata has no matching backend", () => {
    // Negative checks should stay metadata-only; loading setup runtime here
    // would make simple provider visibility queries expensive.
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => {
        throw new Error("setup runtime should not load for CLI provider checks");
      },
    });

    expect(isCliProvider("openai", {} as OpenClawConfig)).toBe(false);
  });
});

describe("classifyAuthCredentialIntegration", () => {
  it("returns OAuth for oauth credentials", () => {
    expect(classifyAuthCredentialIntegration("oauth")).toBe("OAuth");
  });

  it("returns API for api_key credentials", () => {
    expect(classifyAuthCredentialIntegration("api_key")).toBe("API");
  });

  it("returns API for token credentials", () => {
    expect(classifyAuthCredentialIntegration("token")).toBe("API");
  });

  it("returns undefined when no credential type is provided", () => {
    expect(classifyAuthCredentialIntegration(undefined)).toBeUndefined();
  });
});

describe("resolveProviderAuthIntegrationLabel", () => {
  beforeEach(() => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReset();
    authProfilesMocks.resolveAuthProfileOrder.mockReset();
    orderMocks.isStoredCredentialCompatibleWithAuthProvider.mockReset();
    orderMocks.isStoredCredentialCompatibleWithAuthProvider.mockReturnValue(true);
  });

  it("returns undefined when no agent directory is provided", () => {
    expect(
      resolveProviderAuthIntegrationLabel({ provider: "openai", agentDir: undefined }),
    ).toBeUndefined();
    expect(authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
  });

  it("returns OAuth when the first matching profile is an oauth credential", () => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      buildStore({
        "openai:roberto@example.com": {
          type: "oauth",
          provider: "openai",
        } as unknown as AuthProfileCredential,
        "openai:api-key": {
          type: "api_key",
          provider: "openai",
        } as unknown as AuthProfileCredential,
      }),
    );
    authProfilesMocks.resolveAuthProfileOrder.mockReturnValue([
      "openai:roberto@example.com",
      "openai:api-key",
    ]);

    expect(
      resolveProviderAuthIntegrationLabel({ provider: "openai", agentDir: "/tmp/agent" }),
    ).toBe("OAuth");
  });

  it("returns API when only an api-key profile is registered", () => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      buildStore({
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
        } as unknown as AuthProfileCredential,
      }),
    );
    authProfilesMocks.resolveAuthProfileOrder.mockReturnValue(["openrouter:default"]);

    expect(
      resolveProviderAuthIntegrationLabel({ provider: "openrouter", agentDir: "/tmp/agent" }),
    ).toBe("API");
  });

  it("skips incompatible profiles", () => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      buildStore({
        "google:wrong": {
          type: "api_key",
          provider: "google",
        } as unknown as AuthProfileCredential,
        "google:right": {
          type: "oauth",
          provider: "google",
        } as unknown as AuthProfileCredential,
      }),
    );
    authProfilesMocks.resolveAuthProfileOrder.mockReturnValue(["google:wrong", "google:right"]);
    orderMocks.isStoredCredentialCompatibleWithAuthProvider.mockImplementation(
      (params: { credential: AuthProfileCredential }) =>
        (params.credential as AuthProfileCredential & { provider?: string }).provider !==
          undefined && (params.credential as { type: string }).type === "oauth",
    );

    expect(
      resolveProviderAuthIntegrationLabel({ provider: "google", agentDir: "/tmp/agent" }),
    ).toBe("OAuth");
  });

  it("returns undefined when no compatible profiles are found", () => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue(buildStore({}));
    authProfilesMocks.resolveAuthProfileOrder.mockReturnValue([]);

    expect(
      resolveProviderAuthIntegrationLabel({ provider: "unknown", agentDir: "/tmp/agent" }),
    ).toBeUndefined();
  });
});

describe("resolveModelIntegrationLabel", () => {
  beforeEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
    setCliBackendMetadataSnapshot(["claude-cli"]);
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReset();
    authProfilesMocks.resolveAuthProfileOrder.mockReset();
    orderMocks.isStoredCredentialCompatibleWithAuthProvider.mockReset();
    orderMocks.isStoredCredentialCompatibleWithAuthProvider.mockReturnValue(true);
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    setupRegistryRuntimeTesting.resetRuntimeState();
  });

  it("returns CLI when the model is pinned to a CLI runtime", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelIntegrationLabel({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        cfg,
        agentDir: "/tmp/agent",
      }),
    ).toBe("CLI");
    // CLI win should short-circuit; no auth-profile fs lookup.
    expect(authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
  });

  it("falls back to OAuth when the model is not CLI-pinned but the provider has an oauth profile", () => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      buildStore({
        "openai:roberto@example.com": {
          type: "oauth",
          provider: "openai",
        } as unknown as AuthProfileCredential,
      }),
    );
    authProfilesMocks.resolveAuthProfileOrder.mockReturnValue(["openai:roberto@example.com"]);

    expect(
      resolveModelIntegrationLabel({
        provider: "openai",
        modelId: "gpt-5.5",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).toBe("OAuth");
  });

  it("falls back to API when only an api-key profile is registered", () => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      buildStore({
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
        } as unknown as AuthProfileCredential,
      }),
    );
    authProfilesMocks.resolveAuthProfileOrder.mockReturnValue(["openrouter:default"]);

    expect(
      resolveModelIntegrationLabel({
        provider: "openrouter",
        modelId: "auto",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).toBe("API");
  });

  it("returns undefined when neither a CLI runtime nor an auth profile is registered", () => {
    authProfilesMocks.loadAuthProfileStoreWithoutExternalProfiles.mockReturnValue(buildStore({}));
    authProfilesMocks.resolveAuthProfileOrder.mockReturnValue([]);

    expect(
      resolveModelIntegrationLabel({
        provider: "unknown",
        modelId: "model",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).toBeUndefined();
  });
});
