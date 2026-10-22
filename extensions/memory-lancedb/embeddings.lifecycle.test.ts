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
const vector = [0.1, 0.2, 0.3];
const revoked = "Private agent credentials were revoked";
const agentPath = (_config: unknown, agentId: string) => `/tmp/agent-${agentId}`;

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

function blockingGate() {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  return {
    started: started.promise,
    release: () => release.resolve(),
    hold: async () => {
      started.resolve();
      await release.promise;
    },
  };
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
    throw new Error(revoked);
  }
  return profile.key;
}

function providerResult(
  params: {
    id?: string;
    model?: string;
    embedQuery?: (text: string) => Promise<number[]>;
    close?: NonNullable<MemoryEmbeddingProvider["close"]>;
  } = {},
) {
  return {
    provider: {
      id: params.id ?? "openai",
      model: params.model ?? "text-embedding-3-small",
      embed: async (input: Parameters<MemoryEmbeddingProvider["embed"]>[0]) =>
        await (params.embedQuery ?? (async () => vector))(
          typeof input === "string" ? input : input.text,
        ),
      embedBatch: vi.fn(async () => [vector]),
      ...(params.close ? { close: params.close } : {}),
    },
  };
}

function providerHarness(profileId?: string) {
  if (profileId) {
    loadAuthProfileStoreForRuntime(undefined, { readOnly: true, externalCli: { mode: "none" } });
  }
  const requests: Array<[string, string | undefined, string]> = [];
  const close = vi.fn(async (_agentDir: string, _credential?: string) => {});
  const create = vi.fn(async (options: { agentDir?: string }) => {
    const agentDir = expectDefined(options.agentDir, "auth owner");
    const credential = profileId ? readCredential(agentDir, profileId) : undefined;
    return providerResult({
      embedQuery: async (text) => {
        requests.push([agentDir, credential, text]);
        return vector;
      },
      close: async () => close(agentDir, credential),
    });
  });
  useProvider(create);
  return { requests, close, create, embeddings: createEmbeddings(createApi({}, agentPath)) };
}

it("invalidates only the matching normalized auth owner and unregisters on close", async () => {
  const { close, create, embeddings } = providerHarness();
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
  expect(create).toHaveBeenCalledTimes(2);
  await embed(embeddings, "private", "private rotated provider");
  expect(create).toHaveBeenCalledTimes(3);
  expect(close.mock.calls).toEqual([["/tmp/agent-private", undefined]]);
  await embeddings.close?.();
  expect(providerMocks.authMutationListeners.has(expectDefined(listener, "auth listener"))).toBe(
    false,
  );
  expect(close.mock.calls.map(([dir]) => dir).toSorted()).toEqual([
    "/tmp/agent-other",
    "/tmp/agent-private",
    "/tmp/agent-private",
  ]);
});

it.each([false, true])("rotates actual auth snapshots (inherited=%s)", async (inherited) => {
  const agents = inherited ? ["private", "secondary"] : ["private"];
  const profileId = "openai:rotation";
  const publish = (credential?: string) => {
    replaceRuntimeAuthProfileStoreSnapshots([
      { store: credentialStore(profileId, inherited ? credential : undefined) },
      ...agents.map((agent) => ({
        agentDir: agentPath({}, agent),
        store: credentialStore(profileId, inherited ? undefined : credential),
      })),
    ]);
  };
  const { requests, create, close, embeddings } = providerHarness(profileId);
  const calls = (key: string) => agents.map((agent) => [agentPath({}, agent), key]);
  const expected = ["old", "new"].flatMap((key) =>
    calls(key).map(([dir, credential]) => [dir, credential, key]),
  );
  try {
    for (const key of ["old", "new"]) {
      publish(key);
      await Promise.all(agents.map((agent) => embed(embeddings, agent, key)));
    }
    expect(create).toHaveBeenCalledTimes(agents.length * 2);
    expect(close.mock.calls).toEqual(expect.arrayContaining(calls("old")));
    expect(close).toHaveBeenCalledTimes(agents.length);
    expect(inherited ? requests.toSorted() : requests).toEqual(
      inherited ? expected.toSorted() : expected,
    );
    if (!inherited) {
      publish();
      await expect(embed(embeddings, "private", "revoked")).rejects.toThrow(revoked);
      expect(requests).toHaveLength(2);
      expect(close).toHaveBeenCalledTimes(2);
    }
  } finally {
    await embeddings.close?.();
    clearRuntimeAuthProfileStoreSnapshots();
  }
  expect(close.mock.calls.toSorted()).toEqual([...calls("old"), ...calls("new")].toSorted());
});

it("retires cached agent providers and fails closed after runtime config replacement", async () => {
  const initialConfig = { authGeneration: "valid" };
  const revokedConfig = { authGeneration: "revoked" };
  let currentConfig = initialConfig;
  const oldEmbedQuery = vi.fn(async () => vector);
  const closeOldProvider = vi.fn(async () => {});
  const createProvider = vi.fn(async (options: { config: unknown; agentDir?: string }) => {
    if (options.config === revokedConfig) {
      throw new Error(revoked);
    }
    return providerResult({ embedQuery: oldEmbedQuery, close: closeOldProvider });
  });
  useProvider(createProvider);
  const api = createApi(initialConfig, agentPath, () => currentConfig);
  const embeddings = createEmbeddings(api);
  await embed(embeddings, "private", "before revocation");
  currentConfig = revokedConfig;
  await expect(embed(embeddings, "private", "after revocation")).rejects.toThrow(revoked);
  expect(oldEmbedQuery.mock.calls).toEqual([["before revocation"]]);
  expect(closeOldProvider).toHaveBeenCalledOnce();
  expect(createProvider).toHaveBeenCalledTimes(2);
  await embeddings.close?.();
});

it.each(["config", "auth"] as const)("drains admitted work when %s rotates", async (kind) => {
  const gate = blockingGate();
  const closeOld = vi.fn(async () => {});
  const closeNew = vi.fn(async () => {});
  const agentDir = "/tmp/openclaw-lancedb-inflight-auth-rotation";
  const profileId = "openai:inflight";
  const auth = kind === "auth";
  const oldKey = "fixture-old-key";
  const newKey = "fixture-new-key";
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
  const oldVector = auth ? vector : [0.1];
  const newVector = auth ? vector : [0.2];
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
            await gate.hold();
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
    await gate.started;
    if (auth) {
      publishPrivateCredential(agentDir, profileId, newKey);
    }
    const second = embed(embeddings, auth ? "private" : "main", "new account request", newConfig);
    await expect(second).resolves.toEqual(newVector);
    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(closeOld).not.toHaveBeenCalled();
    gate.release();
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
    gate.release();
    await embeddings.close?.();
    if (auth) {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  }
  expect(closeNew).toHaveBeenCalledOnce();
});

it.each(["creation", "embedding"])("drains admitted %s work before close", async (phase) => {
  const gate = blockingGate();
  const closeProvider = vi.fn(async () => {});
  const createProvider = vi.fn(async () => {
    if (phase === "creation") {
      await gate.hold();
    }
    return providerResult({
      close: closeProvider,
      embedQuery: async () => {
        if (phase === "embedding") {
          await gate.hold();
        }
        return vector;
      },
    });
  });
  useProvider(createProvider);
  const embeddings = createEmbeddings(createApi());
  const pending = embed(embeddings, "main", "active");
  await gate.started;
  const closing = embeddings.close?.();
  await Promise.resolve();
  expect(closeProvider).not.toHaveBeenCalled();
  await expect(embed(embeddings, "main", "late")).rejects.toThrow(
    "memory-lancedb embeddings are closed",
  );
  gate.release();
  await expect(pending).resolves.toEqual(vector);
  await closing;
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
