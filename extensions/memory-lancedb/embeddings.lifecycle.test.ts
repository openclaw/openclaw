import { expectDefined } from "@openclaw/normalization-core";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import type { MemoryConfig } from "./config.js";

const providerMocks = vi.hoisted(() => ({
  getMemoryEmbeddingProvider: vi.fn(),
  authMutationListeners: new Set<
    (event: {
      agentDir?: string;
      affectsInheritedStores: boolean;
      profileSetChanged: boolean;
    }) => void
  >(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    getMemoryEmbeddingProvider: providerMocks.getMemoryEmbeddingProvider,
    registerRuntimeAuthProfileStoreMutationListener: (
      listener: Parameters<typeof actual.registerRuntimeAuthProfileStoreMutationListener>[0],
    ) => {
      providerMocks.authMutationListeners.add(listener);
      const unregister = actual.registerRuntimeAuthProfileStoreMutationListener(listener);
      return () => {
        providerMocks.authMutationListeners.delete(listener);
        unregister();
      };
    },
  };
});

import { createEmbeddings, type Embeddings } from "./embeddings.js";

function createApi(
  config: unknown = {},
  resolveAgentDir = (_config: unknown, _agentId: string) => "/tmp/openclaw-agent",
  current = () => config,
): OpenClawPluginApi {
  return {
    config,
    logger: { warn: vi.fn() },
    runtime: { config: { current }, agent: { resolveAgentDir } },
  } as unknown as OpenClawPluginApi;
}

const embeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
} as MemoryConfig["embedding"];

function embed(
  embeddings: Embeddings,
  agentId: string,
  text: string,
  embedding: MemoryConfig["embedding"] = embeddingConfig,
) {
  return embeddings.embed(agentId, text, embedding);
}

function useProvider(create: ReturnType<typeof vi.fn>, id = "openai") {
  providerMocks.getMemoryEmbeddingProvider.mockReturnValue({ id, create });
}

function credentialStore(profileId: string, credential?: string) {
  return {
    version: 1,
    profiles: credential
      ? { [profileId]: { type: "api_key" as const, provider: "openai", key: credential } }
      : {},
  };
}

function publishPrivateCredential(agentDir: string, profileId: string, credential?: string) {
  replaceRuntimeAuthProfileStoreSnapshots([
    { store: credentialStore(profileId) },
    { agentDir, store: credentialStore(profileId, credential) },
  ]);
}

function readCredential(agentDir: string | undefined, profileId: string) {
  const profile = ensureAuthProfileStore(agentDir, {
    externalCli: { mode: "none" },
    readOnly: true,
    syncExternalCli: false,
  }).profiles[profileId];
  if (profile?.type !== "api_key" || !profile.key) {
    throw new Error("Private agent credentials were revoked");
  }
  return profile.key;
}

function providerResult(
  params: {
    id?: string;
    model?: string;
    vector?: number[];
    embedQuery?: (text: string) => Promise<number[]>;
    close?: NonNullable<MemoryEmbeddingProvider["close"]>;
  } = {},
) {
  const vector = params.vector ?? [0.1, 0.2, 0.3];
  return {
    provider: {
      id: params.id ?? "openai",
      model: params.model ?? "text-embedding-3-small",
      embed: async (input: Parameters<MemoryEmbeddingProvider["embed"]>[0]) =>
        await (params.embedQuery ?? vi.fn(async () => vector))(
          typeof input === "string" ? input : input.text,
        ),
      embedBatch: vi.fn(async () => [vector]),
      ...(params.close ? { close: params.close } : {}),
    },
  };
}

function scopedProviderHarness() {
  const requests: Array<{ agentDir: string; text: string }> = [];
  const closedAgentDirs: string[] = [];
  const createProvider = vi.fn(async (options: { agentDir?: string }) => {
    const agentDir = options.agentDir ?? "unscoped";
    return providerResult({
      embedQuery: async (text) => {
        requests.push({ agentDir, text });
        return [0.1, 0.2, 0.3];
      },
      close: async () => {
        closedAgentDirs.push(agentDir);
      },
    });
  });
  useProvider(createProvider);
  const api = createApi({}, (_config, agentId) => "/tmp/agent-" + agentId);
  return { requests, closedAgentDirs, createProvider, embeddings: createEmbeddings(api) };
}

it("isolates concurrent agent providers and retires every account exactly once", async () => {
  const { requests, closedAgentDirs, createProvider, embeddings } = scopedProviderHarness();
  await Promise.all([
    embed(embeddings, "private", "private first"),
    embed(embeddings, "main", "main first"),
    embed(embeddings, " PRIVATE ", "private second"),
    embed(embeddings, "main", "main second"),
  ]);
  expect(createProvider).toHaveBeenCalledTimes(2);
  expect(requests).toEqual(
    expect.arrayContaining([
      { agentDir: "/tmp/agent-private", text: "private first" },
      { agentDir: "/tmp/agent-private", text: "private second" },
      { agentDir: "/tmp/agent-main", text: "main first" },
      { agentDir: "/tmp/agent-main", text: "main second" },
    ]),
  );
  await embeddings.close?.();
  expect(closedAgentDirs.toSorted()).toEqual(["/tmp/agent-main", "/tmp/agent-private"]);
});

it("invalidates only the matching normalized auth owner and unregisters on close", async () => {
  const { closedAgentDirs, createProvider, embeddings } = scopedProviderHarness();
  await Promise.all([
    embed(embeddings, "private", "private before rotation"),
    embed(embeddings, "other", "other before rotation"),
  ]);
  const listener = Array.from(providerMocks.authMutationListeners).at(-1);
  expect(listener).toBeTypeOf("function");
  listener?.({
    agentDir: "/tmp/agent-private/../agent-private",
    affectsInheritedStores: false,
    profileSetChanged: false,
  });
  await embed(embeddings, "other", "other warm provider");
  expect(createProvider).toHaveBeenCalledTimes(2);
  await embed(embeddings, "private", "private rotated provider");
  expect(createProvider).toHaveBeenCalledTimes(3);
  expect(closedAgentDirs).toEqual(["/tmp/agent-private"]);
  await embeddings.close?.();
  expect(providerMocks.authMutationListeners.has(expectDefined(listener, "auth listener"))).toBe(
    false,
  );
  expect(closedAgentDirs.toSorted()).toEqual([
    "/tmp/agent-other",
    "/tmp/agent-private",
    "/tmp/agent-private",
  ]);
});

it("rotates actual private auth snapshots without replacing the runtime config", async () => {
  loadAuthProfileStoreForRuntime(undefined, { readOnly: true, externalCli: { mode: "none" } });
  const config = {};
  const agentDir = "/tmp/openclaw-lancedb-private-auth-rotation";
  const profileId = "openai:private";
  const requests: Array<{ text: string; credential: string }> = [];
  const publishCredential = (credential?: string) =>
    publishPrivateCredential(agentDir, profileId, credential);
  const closeProvider = vi.fn(async () => {});
  const createProvider = vi.fn(async (options: { agentDir?: string }) => {
    const credential = readCredential(options.agentDir, profileId);
    return providerResult({
      embedQuery: vi.fn(async (text: string) => {
        requests.push({ text, credential });
        return [0.1, 0.2, 0.3];
      }),
      close: closeProvider,
    });
  });
  useProvider(createProvider, "openai");
  const api = createApi(config, () => agentDir);
  const embeddings = createEmbeddings(api);
  try {
    publishCredential("fixture-old-account");
    await embed(embeddings, "private", "before-account-rotation");
    publishCredential("fixture-new-account");
    await embed(embeddings, "private", "private-secret-after-account-rotation");
    expect(requests).toEqual([
      { text: "before-account-rotation", credential: "fixture-old-account" },
      { text: "private-secret-after-account-rotation", credential: "fixture-new-account" },
    ]);
    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(closeProvider).toHaveBeenCalledOnce();
    publishCredential(undefined);
    await expect(embed(embeddings, "private", "private-secret-after-revocation")).rejects.toThrow(
      "Private agent credentials were revoked",
    );
    expect(requests).toHaveLength(2);
    expect(closeProvider).toHaveBeenCalledTimes(2);
  } finally {
    await embeddings.close?.();
    clearRuntimeAuthProfileStoreSnapshots();
  }
});

it("invalidates every inheriting agent when the actual main auth snapshot rotates", async () => {
  loadAuthProfileStoreForRuntime(undefined, { readOnly: true, externalCli: { mode: "none" } });
  const config = {};
  const agentDirs = {
    private: "/tmp/openclaw-lancedb-inherited-private",
    secondary: "/tmp/openclaw-lancedb-inherited-secondary",
  };
  const profileId = "openai:inherited";
  const requests: Array<{ agentDir: string; credential: string; text: string }> = [];
  const publishMainCredential = (credential: string) => {
    replaceRuntimeAuthProfileStoreSnapshots([
      { store: credentialStore(profileId, credential) },
      ...Object.values(agentDirs).map((agentDir) => ({
        agentDir,
        store: credentialStore(profileId),
      })),
    ]);
  };
  const closeProvider = vi.fn(async (_agentDir: string, _credential: string) => {});
  const createProvider = vi.fn(async (options: { agentDir?: string }) => {
    const agentDir = expectDefined(options.agentDir, "inherited agent owner");
    const credential = readCredential(agentDir, profileId);
    return providerResult({
      embedQuery: vi.fn(async (text: string) => {
        requests.push({ agentDir, credential, text });
        return [0.1, 0.2, 0.3];
      }),
      close: async () => closeProvider(agentDir, credential),
    });
  });
  useProvider(createProvider, "openai");
  const api = createApi(config, (_config, agentId) => agentDirs[agentId as keyof typeof agentDirs]);
  const embeddings = createEmbeddings(api);
  try {
    publishMainCredential("fixture-inherited-old");
    await Promise.all([
      embed(embeddings, "private", "private old inherited credential"),
      embed(embeddings, "secondary", "secondary old inherited credential"),
    ]);
    publishMainCredential("fixture-inherited-new");
    await Promise.all([
      embed(embeddings, "private", "private new inherited credential"),
      embed(embeddings, "secondary", "secondary new inherited credential"),
    ]);
    expect(createProvider).toHaveBeenCalledTimes(4);
    expect(closeProvider.mock.calls).toEqual(
      expect.arrayContaining([
        [agentDirs.private, "fixture-inherited-old"],
        [agentDirs.secondary, "fixture-inherited-old"],
      ]),
    );
    expect(requests).toEqual(
      expect.arrayContaining(
        [
          [agentDirs.private, "fixture-inherited-old", "private old inherited credential"],
          [agentDirs.secondary, "fixture-inherited-old", "secondary old inherited credential"],
          [agentDirs.private, "fixture-inherited-new", "private new inherited credential"],
          [agentDirs.secondary, "fixture-inherited-new", "secondary new inherited credential"],
        ].map(([agentDir, credential, text]) => ({ agentDir, credential, text })),
      ),
    );
  } finally {
    await embeddings.close?.();
    clearRuntimeAuthProfileStoreSnapshots();
  }
  expect(closeProvider.mock.calls).toHaveLength(4);
  expect(closeProvider.mock.calls).toEqual(
    expect.arrayContaining([
      [agentDirs.private, "fixture-inherited-old"],
      [agentDirs.secondary, "fixture-inherited-old"],
      [agentDirs.private, "fixture-inherited-new"],
      [agentDirs.secondary, "fixture-inherited-new"],
    ]),
  );
});

it("retires cached agent providers and fails closed after runtime config replacement", async () => {
  const initialConfig = { authGeneration: "valid" };
  const revokedConfig = { authGeneration: "revoked" };
  let currentConfig = initialConfig;
  const oldEmbedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);
  const closeOldProvider = vi.fn(async () => {});
  const createProvider = vi.fn(async (options: { config: unknown; agentDir?: string }) => {
    if (options.config === revokedConfig) {
      throw new Error("Private agent credentials were revoked");
    }
    return providerResult({ embedQuery: oldEmbedQuery, close: closeOldProvider });
  });
  useProvider(createProvider, "openai");
  const api = createApi(
    initialConfig,
    (_config: unknown, agentId: string) => `/tmp/agent-${agentId}`,
    () => currentConfig,
  );
  const embeddings = createEmbeddings(api);
  await embed(embeddings, "private", "before revocation");
  currentConfig = revokedConfig;
  await expect(embed(embeddings, "private", "after revocation")).rejects.toThrow(
    "Private agent credentials were revoked",
  );
  expect(oldEmbedQuery).toHaveBeenCalledOnce();
  expect(oldEmbedQuery).toHaveBeenCalledWith("before revocation");
  expect(closeOldProvider).toHaveBeenCalledOnce();
  expect(createProvider).toHaveBeenCalledTimes(2);
  await embeddings.close?.();
});

it.each(["config", "auth"] as const)("drains admitted work when %s rotates", async (kind) => {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const closeOld = vi.fn(async () => {});
  const closeNew = vi.fn(async () => {});
  const agentDir = "/tmp/openclaw-lancedb-inflight-auth-rotation";
  const profileId = "openai:inflight";
  const auth = kind === "auth";
  const oldKey = auth ? "fixture-inflight-old" : "fixture-old-key";
  const newKey = auth ? "fixture-inflight-new" : "fixture-new-key";
  if (auth) {
    loadAuthProfileStoreForRuntime(undefined, { readOnly: true, externalCli: { mode: "none" } });
  }
  const identity = { provider: "fixture-provider", model: "fixture-model", dimensions: 3 };
  const oldConfig = auth
    ? embeddingConfig
    : { ...identity, apiKey: oldKey, baseUrl: "https://old.example.test/v1" };
  const newConfig = auth
    ? embeddingConfig
    : { ...identity, apiKey: newKey, baseUrl: "https://new.example.test/v1" };
  const oldVector = auth ? [0.1, 0.2, 0.3] : [0.1];
  const newVector = auth ? [0.1, 0.2, 0.3] : [0.2];
  const createProvider = vi.fn(
    async (options: {
      provider: string;
      model: string;
      agentDir?: string;
      remote?: { apiKey?: string };
    }) => {
      const key = auth ? readCredential(options.agentDir, profileId) : options.remote?.apiKey;
      const old = key === oldKey;
      return providerResult({
        id: options.provider,
        model: options.model,
        embedQuery: async () => {
          if (old) {
            started.resolve();
            await release.promise;
          }
          return old ? oldVector : newVector;
        },
        close: old ? closeOld : closeNew,
      });
    },
  );
  useProvider(createProvider, auth ? "openai" : identity.provider);
  const embeddings = createEmbeddings(auth ? createApi({}, () => agentDir) : createApi());
  try {
    if (auth) {
      publishPrivateCredential(agentDir, profileId, oldKey);
    }
    const first = embed(embeddings, auth ? "private" : "main", "old account request", oldConfig);
    await started.promise;
    if (auth) {
      publishPrivateCredential(agentDir, profileId, newKey);
    }
    const second = embed(embeddings, auth ? "private" : "main", "new account request", newConfig);
    await expect(second).resolves.toEqual(newVector);
    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(closeOld).not.toHaveBeenCalled();
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([oldVector, newVector]);
    expect(createProvider).toHaveBeenCalledTimes(2);
    if (!auth) {
      expect(createProvider.mock.calls.map(([options]) => options)).toEqual(
        [oldConfig, newConfig].map(({ provider, model, apiKey, baseUrl, dimensions }) =>
          expect.objectContaining({
            provider,
            model,
            remote: { apiKey, baseUrl },
            dimensions,
            fallback: "none",
          }),
        ),
      );
    }
    expect(closeOld).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await embeddings.close?.();
    if (auth) {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  }
  expect(closeNew).toHaveBeenCalledOnce();
});

it("joins pending provider creation and its admitted request before close", async () => {
  const firstCreateGate = createDeferred<void>();
  const firstCreateStarted = createDeferred<void>();
  const closeProvider = vi.fn(async () => {});
  const createProvider = vi.fn(async () => {
    if (createProvider.mock.calls.length === 1) {
      firstCreateStarted.resolve();
      await firstCreateGate.promise;
    }
    return providerResult({ close: closeProvider });
  });
  useProvider(createProvider, "openai");
  const first = createEmbeddings(createApi());
  const firstEmbed = embed(first, "main", "first");
  await firstCreateStarted.promise;
  const closePromise = first.close?.();
  expect(closeProvider).not.toHaveBeenCalled();
  firstCreateGate.resolve();
  await firstEmbed;
  await closePromise;
  expect(closeProvider).toHaveBeenCalledTimes(1);
});

function failedCloseProviders() {
  const closeOlder = vi
    .fn<() => Promise<void>>()
    .mockRejectedValue(new Error("older close failed"));
  const closeCurrent = vi.fn(async () => {});
  useProvider(
    vi
      .fn()
      .mockResolvedValueOnce(providerResult({ close: closeOlder }))
      .mockResolvedValueOnce(providerResult({ close: closeCurrent })),
  );
  return { closeOlder, closeCurrent };
}

it("does not retry failed closes or block independent provider instances", async () => {
  const { closeOlder, closeCurrent } = failedCloseProviders();
  const older = createEmbeddings(createApi());
  const current = createEmbeddings(createApi());
  await embed(older, "main", "older");
  await embed(current, "main", "current");
  await expect(older.close?.()).rejects.toThrow("older close failed");
  await expect(older.close?.()).rejects.toThrow("older close failed");
  await expect(current.close?.()).resolves.toBeUndefined();
  expect(closeOlder).toHaveBeenCalledTimes(1);
  expect(closeCurrent).toHaveBeenCalledTimes(1);
});

it("warns on failed rotation cleanup and still closes the replacement", async () => {
  const { closeOlder, closeCurrent } = failedCloseProviders();
  const api = createApi();
  const embeddings = createEmbeddings(api);
  await embed(embeddings, "main", "before rotation");
  await embed(embeddings, "main", "after rotation", {
    ...embeddingConfig,
    baseUrl: "https://rotated.example.test/v1",
  });
  await expect(embeddings.close?.()).rejects.toThrow("older close failed");
  expect(api.logger.warn).toHaveBeenCalledWith(
    "memory-lancedb: embedding provider cleanup failed; restart the Gateway to reclaim resources",
  );
  expect(closeOlder).toHaveBeenCalledOnce();
  expect(closeCurrent).toHaveBeenCalledOnce();
});

it("drains an admitted embedding before provider close", async () => {
  const embedStarted = createDeferred<void>();
  const embedGate = createDeferred<void>();
  const closeProvider = vi.fn(async () => {});
  providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
    id: "openai",
    create: vi.fn(async () =>
      providerResult({
        embedQuery: vi.fn(async () => {
          embedStarted.resolve();
          await embedGate.promise;
          return [0.1, 0.2, 0.3];
        }),
        close: closeProvider,
      }),
    ),
  });
  const embeddings = createEmbeddings(createApi());
  const embedPromise = embed(embeddings, "main", "active");
  await embedStarted.promise;
  const closePromise = embeddings.close?.();
  await Promise.resolve();
  expect(closeProvider).not.toHaveBeenCalled();
  await expect(embed(embeddings, "main", "late")).rejects.toThrow(
    "memory-lancedb embeddings are closed",
  );
  embedGate.resolve();
  await expect(embedPromise).resolves.toEqual([0.1, 0.2, 0.3]);
  await closePromise;
  expect(closeProvider).toHaveBeenCalledTimes(1);
});
