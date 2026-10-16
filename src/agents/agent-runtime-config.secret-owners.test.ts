import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveQueuedReplyExecutionConfig as resolveReplyConfig } from "../auto-reply/reply/agent-runner-utils.js";
import * as configIo from "../config/io.js";
import {
  cloneConfigWithResolutionFacts as clonePreparedConfig,
  createConfigResolutionFacts as resolutionFacts,
  getConfigResolutionFacts as configFacts,
  setConfigResolutionFacts as setConfigFacts,
} from "../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata as snapshotMetadata,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { getPath, setPathCreateStrict } from "../secrets/path-utils.js";
import * as secretResolver from "../secrets/resolve.js";
import { resolveCommandSecretsFromActiveRuntimeSnapshot } from "../secrets/runtime-command-secrets.js";
import {
  activateSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeConfigSnapshot as activeConfig,
  graftActiveSecretsRuntimeAuthState,
} from "../secrets/runtime-state.js";
import {
  activateSecretsRuntimeSnapshot as activateSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot as prepareSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveAgentRuntimeConfig as resolveRuntimeConfig } from "./agent-runtime-config.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";

const { callGatewayMock } = vi.hoisted(() => ({ callGatewayMock: vi.fn() }));
vi.mock("../gateway/call.js", () => ({ callGateway: callGatewayMock }));

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
let state: OpenClawTestState;
const secretRef = (id: string, source: "env" | "store" = "env") => ({
  source,
  provider: "default",
  id,
});
const expectUnavailable = (result: Promise<unknown>, owner: Record<string, string> = {}) =>
  expect(result).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE", ...owner });
const emptyStore = () => ({ version: 1 as const, profiles: {} });
const fallbackStore = () => ({
  version: 1 as const,
  profiles: {
    "ollama:fallback": { type: "api_key" as const, provider: "ollama", key: "profile-fixture-key" },
  },
});
function providerAuth(
  cfg: OpenClawConfig,
  overrides: Partial<Parameters<typeof resolveApiKeyForProviderCore>[0]> = {},
) {
  return resolveApiKeyForProviderCore({
    provider: "ollama",
    cfg,
    agentDir: state.agentDir(),
    ...overrides,
  });
}
function pinOfflineConfig(config: OpenClawConfig) {
  setRuntimeConfigSnapshot(config, config);
  vi.spyOn(configIo, "readConfigFileSnapshotForWrite").mockRejectedValue(
    new Error("fixture has no source file"),
  );
  callGatewayMock.mockRejectedValue(new Error("fixture gateway offline"));
}

function providerConfig(): OpenClawConfig {
  const provider = (baseUrl: string, api: "openai-completions" | "ollama", key: string) => ({
    baseUrl,
    api,
    apiKey: secretRef(key),
    models: [],
  });
  return {
    plugins: { enabled: false },
    models: {
      providers: {
        healthy: provider(
          "https://healthy.example/v1",
          "openai-completions",
          "TEST_HEALTHY_PROVIDER_KEY",
        ),
        ollama: provider("http://127.0.0.1:11434", "ollama", "TEST_COLD_PROVIDER_KEY"),
      },
    },
  };
}

async function activateProviderConfig(config = providerConfig()) {
  const snapshot = await prepareSnapshot({
    config,
    env: { TEST_HEALTHY_PROVIDER_KEY: "prepared-fixture-key", TEST_COLD_PROVIDER_KEY: undefined },
    agentDirs: [state.agentDir()],
    loadAuthStore: emptyStore,
    allowUnavailableSecretOwners: true,
  });
  expect(snapshot.degradedOwners).toContainEqual(
    expect.objectContaining({ ownerKind: "provider", ownerId: "ollama", degradationState: "cold" }),
  );
  activateSnapshot(snapshot);
  return snapshot;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "agent-secret-owner" });
  clearSecretsRuntimeSnapshot();
  vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", undefined);
  vi.stubEnv("TEST_COLD_PROVIDER_KEY", undefined);
  callGatewayMock.mockReset().mockImplementation(async ({ params }) => ({
    ok: true,
    ...(await resolveCommandSecretsFromActiveRuntimeSnapshot({
      ...params,
      targetIds: new Set(params.targetIds),
      allowedPaths: params.allowedPaths ? new Set(params.allowedPaths) : undefined,
      optionalActivePaths: params.optionalActivePaths
        ? new Set(params.optionalActivePaths)
        : undefined,
    })),
  }));
});

afterEach(async () => {
  clearSecretsRuntimeSnapshot();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await state.cleanup();
});

describe("agent execution respects prepared secret owners", () => {
  it("reuses active config without copying source or reload-only plugin metadata", async () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: "/fixture/workspace" } },
    };
    const facts = resolutionFacts([]);
    setConfigFacts(config, facts);
    const manifestRegistry = {
      plugins: [createPluginManifestRecordFixture({ id: "refresh-context-fixture" })],
    };
    const snapshot = await prepareSnapshot({
      config,
      env: {},
      includeAuthStoreRefs: false,
      manifestRegistry,
    });
    activateSnapshot(snapshot);
    const active = activeConfig();
    const revision = snapshotMetadata()?.revision;
    const clone = vi.spyOn(globalThis, "structuredClone");

    const result = await resolveRuntimeConfig(runtime);

    expect(clone).not.toHaveBeenCalledWith(active?.sourceConfig);
    expect(result).toBe(active?.config);
    expect(configFacts(result)).toBe(facts);
    expect(snapshotMetadata()?.revision).toBe(revision);
    expect(clone).not.toHaveBeenCalledWith(manifestRegistry);
  });

  it("reply starts with a healthy provider while an unrelated explicit provider ref is cold", async () => {
    const snapshot = await activateProviderConfig();
    const revision = snapshotMetadata()?.revision;
    const resolveRef = vi.spyOn(secretResolver, "resolveSecretRefValue");
    const config = await resolveReplyConfig(snapshot.sourceConfig);
    expect(config).toBe(getRuntimeConfigSnapshot());
    expect(config.models?.providers?.healthy?.apiKey).toBe("prepared-fixture-key");
    expect(config.models?.providers?.ollama?.apiKey).toEqual(
      snapshot.sourceConfig.models?.providers?.ollama?.apiKey,
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(resolveRef).not.toHaveBeenCalled();
    expect(snapshotMetadata()?.revision).toBe(revision);
    await expect(
      providerAuth(config, { provider: "healthy", store: emptyStore() }),
    ).resolves.toMatchObject({ apiKey: "prepared-fixture-key" });
    vi.stubEnv("OLLAMA_API_KEY", "ambient-fixture-key");
    await expectUnavailable(
      providerAuth(config, { profileId: "ollama:fallback", store: fallbackStore() }),
      { ownerKind: "provider", ownerId: "ollama" },
    );
  });

  it("keeps a cold provider's request.auth.token ref authoritative over inline, profile, and ambient auth", async () => {
    const source = providerConfig();
    const provider = source.models!.providers!.ollama!;
    provider.apiKey = "inline-fixture-key";
    provider.request = {
      auth: {
        mode: "authorization-bearer",
        token: secretRef("TEST_COLD_PROVIDER_KEY", "store"),
      },
    };
    ModelsConfigSchema.parse(source.models);
    const snapshot = await activateProviderConfig(source);
    const resolveRef = vi.spyOn(secretResolver, "resolveSecretRefValue");
    vi.stubEnv("OLLAMA_API_KEY", "ambient-fixture-key");
    for (const config of [
      await resolveReplyConfig(snapshot.sourceConfig),
      await resolveRuntimeConfig(runtime),
    ]) {
      await expectUnavailable(
        providerAuth(config, {
          credentialPrecedence: "env-first",
          store: fallbackStore(),
        }),
        { ownerId: "ollama" },
      );
    }
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it.each(["provider-auth refresh", "config refresh with auth graft"] as const)(
    "retains config preparation authority after %s",
    async (operation) => {
      const source = providerConfig();
      source.skills = { entries: { fixture: { apiKey: secretRef("TEST_COLD_SKILL_KEY") } } };
      const snapshot = await activateProviderConfig(source);
      if (operation === "provider-auth refresh") {
        await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      } else {
        const candidate = await prepareSnapshot({
          config: source,
          env: { TEST_HEALTHY_PROVIDER_KEY: "prepared-fixture-key" },
          includeAuthStoreRefs: false,
          allowUnavailableSecretOwners: true,
        });
        graftActiveSecretsRuntimeAuthState(candidate);
        activateSnapshot(candidate);
      }
      expect(activeConfig()?.configRefsPrepared).toBe(true);
      for (const config of [
        await resolveReplyConfig(snapshot.sourceConfig),
        await resolveRuntimeConfig(runtime),
      ]) {
        expect(config.skills).toEqual(source.skills);
        await expectUnavailable(providerAuth(config));
      }
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("reuses a cloned prepared runtime config without re-resolution", async () => {
    const snapshot = await activateProviderConfig();
    const input = clonePreparedConfig(snapshot.config);
    const config = await resolveReplyConfig(input);
    expect(config).toEqual(snapshot.config);
    expect(callGatewayMock).not.toHaveBeenCalled();
    await expectUnavailable(providerAuth(config));
  });

  it("requires the same authored-ref facts token with a healthy ref key", async () => {
    const source = providerConfig();
    setConfigFacts(source, resolutionFacts([]));
    const snapshot = await activateProviderConfig(source);
    const input = clonePreparedConfig(snapshot.config);
    await expect(resolveReplyConfig(input)).resolves.toEqual(snapshot.config);
    expect(callGatewayMock).not.toHaveBeenCalled();
    setConfigFacts(
      input,
      resolutionFacts(
        [],
        new Map([["models.providers.healthy.apiKey", "TEST_FOREIGN_PROVIDER_KEY"]]),
      ),
    );
    expect(input).toEqual(snapshot.config);
    expect(configFacts(input)).toEqual(configFacts(snapshot.config));
    expect(configFacts(input)).not.toBe(configFacts(snapshot.config));
    await expect(resolveReplyConfig(input)).rejects.toThrow(
      "is unresolved in the active runtime snapshot",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps foreign-provider reply configs on the strict command path", async () => {
    const snapshot = await activateProviderConfig();
    const input = clonePreparedConfig(snapshot.config);
    input.models!.providers!.ollama!.baseUrl = "https://foreign.example/v1";
    await expect(resolveReplyConfig(input)).rejects.toThrow(
      "is unresolved in the active runtime snapshot",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()).toEqual(snapshot.config);
  });

  it("does not treat an unrecorded snapshot as config-ref preparation authority", async () => {
    const source = providerConfig();
    const snapshot = await prepareSnapshot({
      config: source,
      includeConfigRefs: false,
      agentDirs: [state.agentDir()],
      loadAuthStore: emptyStore,
    });
    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });
    vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", "local-fixture-key");
    await expect(resolveReplyConfig(source)).rejects.toThrow(
      "models.providers.ollama.apiKey is unresolved",
    );
    await expect(resolveRuntimeConfig(runtime)).rejects.toThrow(
      "models.providers.ollama.apiKey is unresolved",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("keeps unprepared agent config strict even if the generic runtime config is pinned", async () => {
    const config = providerConfig();
    pinOfflineConfig(config);
    vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", "local-fixture-key");
    vi.stubEnv("OLLAMA_API_KEY", "ambient-fixture-key");
    await expect(resolveRuntimeConfig(runtime)).rejects.toThrow("failed to resolve secrets");
    expect(getActiveSecretsRuntimeSnapshot()).toBeNull();
  });

  it("keeps explicit channel/account resolution strict without targeting a cold sibling account", async () => {
    const source = providerConfig();
    source.plugins = { allow: ["telegram"], entries: { telegram: { enabled: true } } };
    source.channels = {
      telegram: { accounts: { healthy: { botToken: "fixture-channel-token" } } },
    };
    setPathCreateStrict(
      source,
      ["channels", "telegram", "accounts", "cold", "botToken"],
      secretRef("TEST_COLD_CHANNEL_KEY"),
    );
    vi.stubEnv("TEST_COLD_CHANNEL_KEY", undefined);
    const snapshot = await activateProviderConfig(source);
    expect(snapshot.degradedOwners).toContainEqual(
      expect.objectContaining({ ownerKind: "account", degradationState: "cold" }),
    );
    const replyFor = (accountId: string) =>
      resolveReplyConfig(snapshot.sourceConfig, {
        originatingChannel: "telegram",
        originatingAccountId: accountId,
      });
    const agentFor = (accountId: string) =>
      resolveRuntimeConfig(runtime, {
        runtimeChannelSecretScope: { channel: "telegram", accountId },
      });
    for (const resolve of [replyFor, agentFor]) {
      await expect(resolve("healthy")).resolves.toEqual(snapshot.config);
    }
    expect(callGatewayMock).not.toHaveBeenCalled();
    for (const resolve of [replyFor, agentFor]) {
      await expect(resolve("cold")).rejects.toThrow(
        "channels.telegram.accounts.cold.botToken is unresolved",
      );
    }
    await expect(
      resolveRuntimeConfig(runtime, { runtimeTargetsChannelSecrets: true }),
    ).rejects.toThrow("channels.telegram.accounts.cold.botToken is unresolved");
  });

  it("resolves a persona-only agent SecretRef for local agent commands", async () => {
    const config: OpenClawConfig = { plugins: { enabled: false } };
    const keyPath = [
      ..."agents.entries.reader.tts.personas".split("."),
      "reader.uk",
      ..."providers.mock.apiKey".split("."),
    ];
    const personaRef = secretRef("TEST_TTS_PERSONA_ONLY_KEY");
    setPathCreateStrict(config, keyPath, personaRef);
    pinOfflineConfig(config);
    vi.stubEnv("TEST_TTS_PERSONA_ONLY_KEY", "persona-only-fixture-key");

    const resolved = await resolveRuntimeConfig(runtime);

    expect(getPath(resolved, keyPath)).toBe("persona-only-fixture-key");
    expect(getPath(config, keyPath)).toEqual(personaRef);
  });

  it("does not resolve unrelated channel, plugin, or Gateway refs for standalone nondelivery", async () => {
    const config = providerConfig();
    delete config.models!.providers!.ollama;
    const unrelatedRef = { source: "exec", provider: "unrelated", id: "key" } as const;
    config.secrets = {
      providers: { unrelated: { source: "exec", command: "/fixture-must-not-execute" } },
    };
    setPathCreateStrict(config, ["channels", "telegram", "botToken"], unrelatedRef);
    config.gateway = { auth: { mode: "token", token: unrelatedRef } };
    config.plugins = {
      enabled: false,
      entries: {
        acpx: {
          config: { mcpServers: { fixture: { command: "fixture", env: { TOKEN: unrelatedRef } } } },
        },
      },
    };
    pinOfflineConfig(config);
    vi.stubEnv("TEST_HEALTHY_PROVIDER_KEY", "local-fixture-key");
    const resolveRef = vi.spyOn(secretResolver, "resolveSecretRefValue");
    const result = await resolveRuntimeConfig(runtime);
    expect(result.models?.providers?.healthy?.apiKey).toBe("local-fixture-key");
    const { channels, gateway, plugins } = result;
    expect({ channels, gateway, plugins }).toEqual({
      channels: config.channels,
      gateway: config.gateway,
      plugins: config.plugins,
    });
    expect(resolveRef.mock.calls.map(([ref]) => ref.id)).toEqual(["TEST_HEALTHY_PROVIDER_KEY"]);
  });
});
