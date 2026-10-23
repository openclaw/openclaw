/** Tests external CLI scoping during agent auth-profile credential discovery. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const storeMocks = vi.hoisted(() => ({
  ensureAuthProfileStoreAsync: vi.fn(() => ({ version: 1, profiles: {} })),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: vi.fn(() => ({ version: 1, profiles: {} })),
}));

const credentialMocks = vi.hoisted(() => ({
  resolveAgentCredentialMapFromStore: vi.fn(() => ({})),
}));

const envAuthMocks = vi.hoisted(() => ({
  lookup: vi.fn<typeof import("./model-auth-env-vars.js").resolveProviderEnvAuthLookupMaps>(),
  resolveEnvApiKey: vi.fn<typeof import("./model-auth-env.js").resolveEnvApiKey>(),
}));

const syntheticAuthMocks = vi.hoisted(() => ({
  resolveRuntimeSyntheticAuthProviderRefs: vi.fn(() => []),
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
  prepareProviderSyntheticAuthWithPlugin: vi.fn(),
}));

vi.mock("./auth-profiles/store-runtime.js", () => storeMocks);

vi.mock("./agent-auth-credentials.js", () => credentialMocks);

vi.mock("./model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: envAuthMocks.lookup,
}));
vi.mock("./model-auth-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-auth-env.js")>()),
  resolveEnvApiKey: envAuthMocks.resolveEnvApiKey,
}));

vi.mock("../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs:
    syntheticAuthMocks.resolveRuntimeSyntheticAuthProviderRefs,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin,
  prepareProviderSyntheticAuthWithPlugin: syntheticAuthMocks.prepareProviderSyntheticAuthWithPlugin,
}));

import {
  resolveAgentDiscoveryAuthFacts,
  resolveAmbientAgentCredentialsForDiscovery,
  prepareAmbientAgentCredentialsForDiscovery,
} from "./agent-auth-discovery.js";
import { externalCliDiscoveryForProviders } from "./auth-profiles/external-cli-discovery.js";

describe("resolveAgentDiscoveryAuthFacts external CLI scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialMocks.resolveAgentCredentialMapFromStore.mockReturnValue({});
    envAuthMocks.lookup.mockReturnValue({
      aliasMap: {},
      envCandidateMap: {},
      authEvidenceMap: {},
      setupProviderFallbackRefs: [],
    });
    envAuthMocks.resolveEnvApiKey.mockReset();
  });

  it("threads scoped external CLI discovery into writable auth store loading", async () => {
    const cfg = {} as OpenClawConfig;
    const externalCli = externalCliDiscoveryForProviders({
      cfg,
      providers: ["fireworks"],
    });

    await resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
      config: cfg,
      env: {},
      externalCli,
    });

    expect(storeMocks.ensureAuthProfileStoreAsync).toHaveBeenCalledWith("/tmp/openclaw-agent", {
      allowKeychainPrompt: false,
      config: cfg,
      externalCli,
    });
  });

  it("merges prepared ambient credentials without repeating ambient discovery", async () => {
    credentialMocks.resolveAgentCredentialMapFromStore.mockReturnValue({
      fireworks: { type: "api_key", key: "agent-key" },
    });

    const { credentials } = await resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
      ambientCredentials: {
        fireworks: { type: "api_key", key: "ambient-key" },
        "claude-cli": { type: "api_key", key: "synthetic-key" },
      },
      env: {},
      readOnly: true,
    });

    expect(credentials).toEqual({
      fireworks: { type: "api_key", key: "agent-key" },
      "claude-cli": { type: "api_key", key: "synthetic-key" },
    });
    expect(envAuthMocks.lookup).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveRuntimeSyntheticAuthProviderRefs).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
  });

  it("can skip runtime external auth overlays and scope synthetic auth discovery", async () => {
    await resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
      env: {},
      skipExternalAuthProfiles: true,
      syntheticAuthProviderRefs: ["fireworks"],
    });

    expect(storeMocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).toHaveBeenCalledWith(
      "/tmp/openclaw-agent",
      {
        allowKeychainPrompt: false,
      },
    );
    expect(storeMocks.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveRuntimeSyntheticAuthProviderRefs).not.toHaveBeenCalled();
    expect(syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin).toHaveBeenCalledWith({
      provider: "fireworks",
      config: undefined,
      workspaceDir: undefined,
      env: {},
      context: {
        config: undefined,
        provider: "fireworks",
        providerConfig: undefined,
      },
    });
  });

  it.each(["read", "prepare"])(
    "keeps authoritative native auth separate from provider aliases during %s",
    async (mode) => {
      envAuthMocks.lookup.mockReturnValueOnce({
        aliasMap: {},
        envCandidateMap: { "claude-cli": ["ANTHROPIC_API_KEY"] },
        authEvidenceMap: {},
        setupProviderFallbackRefs: [],
      });
      envAuthMocks.resolveEnvApiKey.mockReturnValueOnce({
        apiKey: "provider-key",
        source: "env: ANTHROPIC_API_KEY",
      });
      const resolveSyntheticAuth = vi.fn((_provider: string) => undefined);

      const options = {
        env: { ANTHROPIC_API_KEY: "provider-key" },
        syntheticAuthProviderRefs: ["claude-cli"],
        authoritativeSyntheticAuthProviderRefs: ["claude-cli"],
        resolveSyntheticAuth,
      };
      const credentials =
        mode === "read"
          ? resolveAmbientAgentCredentialsForDiscovery(options)
          : await prepareAmbientAgentCredentialsForDiscovery({
              ...options,
              resolveSyntheticAuth: async (provider) => resolveSyntheticAuth(provider),
            });
      expect(credentials).toEqual({});
      expect(resolveSyntheticAuth).toHaveBeenCalledWith("claude-cli");
    },
  );

  it.each(["oauth", "token"] as const)(
    "skips synthetic api-key fills under a %s provider pin",
    async (auth) => {
      syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue({
        apiKey: "synthetic-key",
      });
      const cfg = {
        models: {
          providers: {
            fireworks: { auth, baseUrl: "https://example.invalid", models: [] },
          },
        },
      } satisfies OpenClawConfig;

      const { credentials } = await resolveAgentDiscoveryAuthFacts("/tmp/openclaw-agent", {
        config: cfg,
        env: {},
        syntheticAuthProviderRefs: ["fireworks"],
      });

      expect(credentials.fireworks).toBeUndefined();
      expect(syntheticAuthMocks.resolveProviderSyntheticAuthWithPlugin).not.toHaveBeenCalled();
    },
  );
});
