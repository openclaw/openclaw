// Catalog auth tests exercise profile selection and credential-free registry boundaries.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { saveAuthProfileStore } from "../auth-profiles.js";
import {
  attachAuthStorageProfiles,
  attachLiveAuthStorageProfiles,
  markAuthStorageCredentialFree,
} from "./auth-storage-profiles.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

const tempDirs: string[] = [];

function writeCatalog(
  apiKey: string | undefined,
  headers?: Record<string, string>,
  auth?: "aws-sdk",
): string {
  const agentDir = mkdtempSync(join(tmpdir(), "openclaw-model-registry-auth-"));
  tempDirs.push(agentDir);
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          apiKey,
          auth,
          headers,
          models: [{ id: "example-model", headers }],
        },
      },
    }),
  );
  return modelsPath;
}

afterEach(() => {
  vi.unstubAllEnvs();
  closeOpenClawAgentDatabasesForTest();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ModelRegistry catalog auth", () => {
  it.each(["rotation", "removal"])(
    "rejects exact-profile %s during request preparation",
    async (change) => {
      const modelsPath = writeCatalog("auth-profile:custom:named");
      const agentDir = dirname(modelsPath);
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "custom:named": { type: "api_key", provider: "custom", key: "initial-fixture" },
          },
        },
        agentDir,
      );
      const storage = AuthStorage.forAgent(agentDir);
      const registry = ModelRegistry.create(storage, modelsPath);
      const model = registry.find("custom", "example-model")!;
      const pending = registry.getApiKeyAndHeaders(model);
      saveAuthProfileStore(
        {
          version: 1,
          profiles:
            change === "rotation"
              ? {
                  "custom:named": { type: "api_key", provider: "custom", key: "rotated-fixture" },
                }
              : {},
        },
        agentDir,
      );
      storage.reload();
      await expect(pending).resolves.toMatchObject({ ok: false });
    },
  );

  it("keeps explicit uppercase references terminal after removal and restart", async () => {
    const modelsPath = writeCatalog("auth-profile:CUSTOM_KEY");
    const agentDir = dirname(modelsPath);
    vi.stubEnv("CUSTOM_KEY", "unrelated-environment-fixture");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          CUSTOM_KEY: { type: "api_key", provider: "custom", key: "canonical-fixture" },
        },
      },
      agentDir,
    );
    const storage = AuthStorage.forAgent(agentDir);
    const registry = ModelRegistry.create(storage, modelsPath);
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("canonical-fixture");
    saveAuthProfileStore({ version: 1, profiles: {} }, agentDir);
    storage.reload();
    registry.refresh();
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    const restarted = ModelRegistry.create(AuthStorage.forAgent(agentDir), modelsPath);
    await expect(restarted.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    const model = restarted.find("custom", "example-model")!;
    await expect(restarted.getApiKeyAndHeaders(model)).resolves.toMatchObject({ ok: false });
  });

  it("rejects exact-profile/AWS conflicts without changing anonymous or AWS routes", async () => {
    for (const auth of [undefined, "aws-sdk"] as const) {
      const anonymous = ModelRegistry.create(
        AuthStorage.inMemory(),
        writeCatalog(undefined, undefined, auth),
      );
      await expect(
        anonymous.getApiKeyAndHeaders(anonymous.find("custom", "example-model")!),
      ).resolves.toMatchObject({ ok: true });
    }
    const storage = attachAuthStorageProfiles(AuthStorage.inMemory(), {
      version: 1,
      profiles: {
        named: { type: "api_key", provider: "custom", key: "named-fixture" },
      },
    });
    const conflicted = ModelRegistry.create(
      storage,
      writeCatalog("auth-profile:named", undefined, "aws-sdk"),
    );
    expect(conflicted.getAvailable()).toEqual([]);
    await expect(
      conflicted.getApiKeyAndHeaders(conflicted.find("custom", "example-model")!),
    ).resolves.toMatchObject({ ok: false });
  });

  it("does not restore catalog environment selectors in descendant forks", async () => {
    vi.stubEnv("CUSTOM_API_KEY", "environment-fixture");
    const registry = ModelRegistry.create(AuthStorage.inMemory(), writeCatalog("CUSTOM_API_KEY"));
    const free = registry.fork(markAuthStorageCredentialFree(AuthStorage.inMemory()));
    const descendant = free.fork(AuthStorage.inMemory());
    for (const candidate of [free, descendant]) {
      await expect(candidate.getApiKeyForProvider("custom")).resolves.toBeUndefined();
      candidate.refresh();
      await expect(candidate.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    }
  });

  it.each(["expired", "different-provider"])(
    "keeps an uppercase %s profile terminal",
    async (kind) => {
      vi.stubEnv("CUSTOM_KEY", "unrelated-environment-fixture");
      const storage = attachAuthStorageProfiles(AuthStorage.inMemory(), {
        version: 1,
        profiles: {
          CUSTOM_KEY:
            kind === "expired"
              ? { type: "token", provider: "custom", token: "expired-fixture", expires: 1 }
              : { type: "api_key", provider: "another-provider", key: "other-fixture" },
        },
      });
      const registry = ModelRegistry.create(storage, writeCatalog("CUSTOM_KEY"));
      await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
      expect(registry.getAvailable()).toEqual([]);
    },
  );

  it("uses captured alias metadata for exact-profile auth and forks", async () => {
    const store = {
      version: 1,
      profiles: {
        named: { type: "api_key" as const, provider: "canonical-custom", key: "alias-fixture" },
      },
    };
    const storage = attachAuthStorageProfiles(AuthStorage.inMemory(), store);
    const registry = ModelRegistry.create(storage, writeCatalog("named"), {
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom-owner",
            providers: ["custom"],
            providerAuthAliases: { custom: "canonical-custom" },
          },
        ],
      }),
    });
    for (const candidate of [
      registry,
      registry.fork(attachAuthStorageProfiles(AuthStorage.inMemory(), store)),
    ]) {
      await expect(candidate.getApiKeyForProvider("custom")).resolves.toBe("alias-fixture");
      expect(candidate.getAvailable()).toHaveLength(1);
    }
  });

  it("keeps catalog request headers out of credential-free forks and refreshes", async () => {
    const registry = ModelRegistry.create(
      AuthStorage.inMemory(),
      writeCatalog("CUSTOM_API_KEY", { Authorization: "Bearer header-fixture" }),
    );
    const model = registry.find("custom", "example-model")!;
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      headers: { Authorization: "Bearer header-fixture" },
    });
    const credentialFree = registry.fork(markAuthStorageCredentialFree(AuthStorage.inMemory()));
    for (const candidate of [credentialFree, credentialFree.fork(AuthStorage.inMemory())]) {
      await expect(candidate.getApiKeyAndHeaders(model)).resolves.toMatchObject({
        headers: undefined,
      });
      candidate.refresh();
      await expect(candidate.getApiKeyAndHeaders(model)).resolves.toMatchObject({
        headers: undefined,
      });
    }
  });

  it("uses the request endpoint consistently for exact-profile availability and auth", async () => {
    const storage = attachLiveAuthStorageProfiles(
      AuthStorage.inMemory(),
      (_provider, _profileId, baseUrl) => {
        if (baseUrl !== "https://models.example/v1") {
          throw new Error("Endpoint requires migration");
        }
        return { profile: { type: "api_key", provider: "custom", key: "endpoint-fixture" } };
      },
      (profileId) => profileId === "custom:named",
    );
    const registry = ModelRegistry.create(storage, writeCatalog("custom:named"));
    const model = registry.find("custom", "example-model")!;
    expect(registry.hasConfiguredAuth(model)).toBe(true);
    expect(registry.getAvailable()).toContainEqual(model);
    expect(registry.getProviderAuthStatus("custom").configured).toBe(true);
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("endpoint-fixture");
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      apiKey: "endpoint-fixture",
    });
  });

  it("resolves current named-profile credentials after rotation and removal", async () => {
    const modelsPath = writeCatalog("custom:named");
    const agentDir = dirname(modelsPath);
    const persist = (key?: string) =>
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "custom:default": { type: "api_key", provider: "custom", key: "unused-default" },
            ...(key
              ? { "custom:named": { type: "api_key" as const, provider: "custom", key } }
              : {}),
          },
        },
        agentDir,
      );
    persist("initial-fixture");
    const storage = AuthStorage.forAgent(agentDir);
    const registry = ModelRegistry.create(storage, modelsPath);
    const model = registry.find("custom", "example-model")!;
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      apiKey: "initial-fixture",
    });
    persist("rotated-fixture");
    storage.reload();
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      apiKey: "rotated-fixture",
    });
    persist();
    storage.reload();
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
  });

  it("accepts underscore-leading environment references without treating them as profile ids", async () => {
    vi.stubEnv("_CATALOG_TEST_KEY", "env-fixture");
    const registry = ModelRegistry.create(
      AuthStorage.inMemory(),
      writeCatalog("_CATALOG_TEST_KEY"),
    );
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("env-fixture");
  });

  it("never treats plaintext catalog auth or another default as outbound auth", async () => {
    const template = ModelRegistry.create(AuthStorage.inMemory(), writeCatalog("plaintext-key"));
    const authStorage = AuthStorage.inMemory({
      custom: { type: "api_key", key: "different-default" },
    });
    authStorage.setFallbackResolver(() => "generic-fallback");
    const registry = template.fork(authStorage);

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    authStorage.setRuntimeApiKey("custom", "runtime-override");
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("runtime-override");
  });

  it("resolves a non-default catalog profile without selecting an occupied default", async () => {
    const modelsPath = writeCatalog("custom:models-json");
    const agentDir = dirname(modelsPath);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "wrong-default" },
          "custom:models-json": { type: "api_key", provider: "custom", key: "catalog-key" },
        },
      },
      agentDir,
    );
    const registry = ModelRegistry.create(AuthStorage.forAgent(agentDir), modelsPath);

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("catalog-key");
    await expect(
      registry
        .fork(AuthStorage.inMemory({ custom: { type: "api_key", key: "wrong-default" } }))
        .getApiKeyForProvider("custom"),
    ).resolves.toBeUndefined();
  });

  it("keeps an exact default authoritative and updates removal state", async () => {
    const modelsPath = writeCatalog("custom:default");
    const agentDir = dirname(modelsPath);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "catalog-key" },
          "custom:backup": { type: "api_key", provider: "custom", key: "ordered-first" },
        },
        order: { custom: ["custom:backup", "custom:default"] },
      },
      agentDir,
    );
    const authStorage = AuthStorage.forAgent(agentDir);
    const registry = ModelRegistry.create(authStorage, modelsPath);

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("catalog-key");
    authStorage.remove("custom");
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    expect(registry.getAvailable()).toEqual([]);
  });

  it("keeps dynamic provider auth out of credential-free forks", async () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider("custom", {
      apiKey: "dynamic-secret",
      headers: { Authorization: "Bearer dynamic-header-fixture" },
      baseUrl: "https://models.example/v1",
      api: "openai-responses",
      models: [
        {
          id: "example-model",
          name: "Example Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
          headers: { "X-Token": "model-header-fixture" },
        },
      ],
    });

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("dynamic-secret");
    const credentialFree = registry.fork(markAuthStorageCredentialFree(AuthStorage.inMemory()));
    await expect(credentialFree.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    const model = credentialFree.find("custom", "example-model")!;
    await expect(credentialFree.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      headers: undefined,
    });
    credentialFree.registerProvider("custom", {
      apiKey: "late-dynamic-fixture",
      headers: { Authorization: "Bearer late-header-fixture" },
      baseUrl: "https://models.example/v1",
      api: "openai-responses",
    });
    await expect(credentialFree.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    expect(credentialFree.hasConfiguredAuth(model)).toBe(false);
    expect(credentialFree.getAvailable()).toEqual([]);
    const descendant = credentialFree.fork(AuthStorage.inMemory());
    descendant.refresh();
    await expect(descendant.getApiKeyForProvider("custom")).resolves.toBeUndefined();
    await expect(descendant.getApiKeyAndHeaders(model)).resolves.toMatchObject({
      apiKey: undefined,
      headers: undefined,
    });
    credentialFree.authStorage.setRuntimeApiKey("custom", "explicit-runtime-fixture");
    await expect(credentialFree.getApiKeyForProvider("custom")).resolves.toBe(
      "explicit-runtime-fixture",
    );
    expect(credentialFree.hasConfiguredAuth(model)).toBe(true);
  });
});
