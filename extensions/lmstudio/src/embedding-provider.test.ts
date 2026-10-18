import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
// Memory-core owns fallback selection and strips the primary endpoint and
// credentials; its adapter disables fallback in this private factory.
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lmstudioMemoryEmbeddingProviderAdapter } from "../memory-embedding-adapter.js";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";
import type { LmstudioModelWire } from "./models.js";

const prepareModel = vi.hoisted(() =>
  vi.fn(async (_params?: { requestedContextLength?: number }) => ({
    modelKey: "text-embedding-nomic-embed-text-v1.5",
  })),
);
const fetchModels = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({
    reachable: true,
    status: 200,
    models: [] as LmstudioModelWire[],
  })),
);
const resolveRuntimeKey = vi.hoisted(() => vi.fn(async (_params?: unknown) => undefined));
const embeddedModels = vi.hoisted(() => [] as string[]);
const createRemote = vi.hoisted(() =>
  vi.fn((params: { client: { model: string } }) => {
    return {
      id: "lmstudio",
      model: params.client.model,
      embed: vi.fn(async () => {
        embeddedModels.push(params.client.model);
        return [1, 0];
      }),
      embedBatch: vi.fn(async (texts: string[]) => {
        embeddedModels.push(params.client.model);
        return texts.map(() => [1, 0]);
      }),
    };
  }),
);

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return { ...actual, createRemoteEmbeddingProvider: createRemote };
});

vi.mock("./models.fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.fetch.js")>();
  return {
    ...actual,
    prepareLmstudioModelForInference: prepareModel,
    fetchLmstudioModels: fetchModels,
  };
});

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    resolveLmstudioRuntimeApiKey: resolveRuntimeKey,
  };
});

const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

type FixtureOptions = {
  model?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  providerId?: string;
} & Pick<Parameters<typeof createLmstudioEmbeddingProvider>[0], "acquireLocalService" | "remote">;
function embeddingOptions({
  model,
  provider,
  providerId = "lmstudio",
  ...options
}: FixtureOptions = {}) {
  const config = {
    models: {
      providers: {
        [providerId]: {
          baseUrl: "http://localhost:1234/v1",
          models: [{ id: EMBEDDING_MODEL, ...model }],
          ...provider,
        },
      },
    },
  } as unknown as OpenClawConfig;
  return {
    config,
    provider: providerId,
    fallback: "none",
    ...options,
    model: `${providerId}/${model?.id ?? EMBEDDING_MODEL}`,
  };
}
const createEmbedding = (options: FixtureOptions = {}) =>
  createLmstudioEmbeddingProvider(embeddingOptions(options));
const createAdapter = (options: FixtureOptions = {}) =>
  lmstudioMemoryEmbeddingProviderAdapter.create(embeddingOptions(options));

describe("createLmstudioEmbeddingProvider preload context length", () => {
  beforeEach(() => {
    prepareModel.mockClear();
    fetchModels.mockClear();
    fetchModels.mockResolvedValue({ reachable: true, status: 200, models: [] });
    createRemote.mockClear();
    embeddedModels.length = 0;
    resolveRuntimeKey.mockClear();
  });

  it.each<[string, FixtureOptions["model"], number | undefined]>([
    ["contextTokens before native window", { contextTokens: 4096, contextWindow: 8192 }, 4096],
    ["native window without active cap", { contextWindow: 8192 }, 8192],
    ["loader default without configuration", undefined, undefined],
  ])("uses %s", async (_name, model, expected) => {
    await createEmbedding({ model });
    expect(prepareModel).toHaveBeenCalledTimes(1);
    expect(prepareModel.mock.calls[0]?.[0]?.requestedContextLength).toBe(expected);
  });

  it("keeps each query-batch service lease until its request settles", async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const acquireLocalService = vi
      .fn()
      .mockResolvedValueOnce({ release: firstRelease })
      .mockResolvedValueOnce({ release: secondRelease });
    const secondResult = createDeferred<number[]>();
    const remoteEmbed = vi
      .fn()
      .mockRejectedValueOnce(new Error("first query failed"))
      .mockImplementationOnce(async () => await secondResult.promise);
    const remoteEmbedBatch = vi.fn(
      async (inputs: unknown[]) =>
        await Promise.all(
          inputs.map(async (input) => await remoteEmbed(input, { inputType: "query" })),
        ),
    );
    createRemote.mockReturnValueOnce({
      id: "lmstudio",
      model: EMBEDDING_MODEL,
      embed: remoteEmbed,
      embedBatch: remoteEmbedBatch,
    });
    const { provider } = await createEmbedding({
      provider: { params: { preload: false }, localService: { command: "/usr/bin/lms" } },
      acquireLocalService,
    });

    const pending = provider.embedBatch(["first", "second"], { inputType: "query" });
    await expect(pending).rejects.toThrow("first query failed");

    const leaseCall = [
      expect.objectContaining({ providerId: "lmstudio", baseUrl: "http://localhost:1234/v1" }),
      undefined,
    ];
    expect(acquireLocalService.mock.calls).toEqual([leaseCall, leaseCall]);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    expect(remoteEmbedBatch).not.toHaveBeenCalled();

    secondResult.resolve([2]);
    await vi.waitFor(() => expect(secondRelease).toHaveBeenCalledOnce());
  });

  it("resolves a JIT variant before freezing provider and cache identity", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    const release = vi.fn();
    const acquireLocalService = vi.fn(async () => ({ release }));
    fetchModels.mockResolvedValueOnce({
      reachable: true,
      status: 200,
      models: [
        {
          type: "embedding",
          key: EMBEDDING_MODEL,
          variants: [requestedVariant],
          selected_variant: requestedVariant,
          loaded_instances: [],
        },
      ],
    });

    const result = await createAdapter({
      model: { id: requestedVariant },
      provider: { params: { preload: false }, localService: { command: "/usr/bin/lms" } },
      acquireLocalService,
    });
    if (!result.provider) {
      throw new Error("expected LM Studio embedding provider");
    }

    expect(prepareModel).not.toHaveBeenCalled();
    expect(fetchModels).toHaveBeenCalledOnce();
    expect(acquireLocalService).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(result.provider.model).toBe(EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toMatchObject({ model: EMBEDDING_MODEL });

    await expect(result.provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);

    expect(embeddedModels).toEqual([EMBEDDING_MODEL]);
    expect(acquireLocalService).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("retains the discovered canonical model when its preload subsequently fails", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    prepareModel.mockRejectedValueOnce(
      Object.assign(new Error("fixture preload rejected"), { resolvedModelKey: EMBEDDING_MODEL }),
    );

    const result = await createAdapter({ model: { id: requestedVariant } });

    expect(createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.objectContaining({ model: EMBEDDING_MODEL }) }),
    );
    expect(result.provider?.model).toBe(EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toMatchObject({ model: EMBEDDING_MODEL });
  });

  it("keeps the requested model when preload fails before discovering its identity", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    prepareModel.mockRejectedValueOnce(new Error("fixture discovery unavailable"));

    const { client } = await createEmbedding({ model: { id: requestedVariant } });

    expect(client.model).toBe(requestedVariant);
    expect(createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.objectContaining({ model: requestedVariant }) }),
    );
  });

  it("leases the exact configured alias for preload and embedding requests", async () => {
    const release = vi.fn();
    const acquireLocalService = vi.fn(async (_target: unknown) => ({ release }));
    const result = await createAdapter({
      providerId: "lmstudio-spark",
      provider: {
        baseUrl: "http://spark.local:1234/v1",
        apiKey: "spark-key",
        localService: { command: "/usr/bin/lms-spark", args: ["server", "start"], idleStopMs: 10 },
      },
      acquireLocalService,
    });
    const provider = result.provider;
    if (!provider) {
      throw new Error("expected LM Studio embedding provider");
    }
    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);
    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "lmstudio-spark",
      baseUrl: "http://spark.local:1234/v1",
      model: EMBEDDING_MODEL,
    });

    expect(prepareModel).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "spark-key" }));
    expect(resolveRuntimeKey).not.toHaveBeenCalled();
    const leaseCall = [
      {
        providerId: "lmstudio-spark",
        baseUrl: "http://spark.local:1234/v1",
        headers: { Authorization: "Bearer spark-key", "Content-Type": "application/json" },
      },
      undefined,
    ];
    expect(acquireLocalService.mock.calls).toEqual([leaseCall, leaseCall]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not lease a configured local service for a remote endpoint override", async () => {
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    const { provider, client } = await createEmbedding({
      providerId: "lmstudio-spark",
      provider: {
        baseUrl: "http://spark.local:1234/v1",
        apiKey: "provider-host-key",
        headers: { "X-Provider-Tenant": "provider-a" },
        localService: { command: process.execPath },
      },
      remote: {
        baseUrl: "http://memory.local:1234/v1",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      acquireLocalService,
    });

    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);
    expect(acquireLocalService).not.toHaveBeenCalled();
    expect(client.headers).toEqual({
      "Content-Type": "application/json",
      "X-Remote-Tenant": "remote-b",
    });
  });

  it("preserves a scheme-added /api/v1 local service target", async () => {
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    await createEmbedding({
      providerId: "lmstudio-spark",
      provider: { baseUrl: "spark.local:1234/api/v1", localService: { command: process.execPath } },
      acquireLocalService,
    });

    expect(resolveRuntimeKey).not.toHaveBeenCalled();
    expect(acquireLocalService).toHaveBeenCalledWith(
      {
        providerId: "lmstudio-spark",
        baseUrl: "http://spark.local:1234/api/v1",
        headers: { "Content-Type": "application/json" },
      },
      undefined,
    );
  });

  it("keeps API key rotation out of memory identity without dropping tenant headers", async () => {
    const readIdentity = async (headers: Record<string, string>) =>
      (await createAdapter({ provider: { params: { preload: false } }, remote: { headers } }))
        .runtime?.cacheKeyData;

    const defaultIdentity = await readIdentity({});
    const firstTenant = await readIdentity({
      Authorization: "Bearer synthetic-before",
      "X-API-KEY": "synthetic-key-before",
      "X-Tenant": "tenant-a",
    });
    const rotatedTenant = await readIdentity({
      Authorization: "Bearer synthetic-after",
      "x-Api-Key": "synthetic-key-after",
      "X-Tenant": "tenant-a",
    });
    const otherTenant = await readIdentity({
      "X-Api-Key": "synthetic-key-after",
      "X-Tenant": "tenant-b",
    });

    expect(defaultIdentity).toEqual({
      provider: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
      model: EMBEDDING_MODEL,
      headers: [["Content-Type", "application/json"]],
    });
    expect(firstTenant).toEqual(rotatedTenant);
    expect(firstTenant).not.toEqual(otherTenant);
    expect(firstTenant).toMatchObject({
      headers: [
        ["Content-Type", "application/json"],
        ["X-Tenant", "tenant-a"],
      ],
    });
  });
});
