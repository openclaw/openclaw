// Memory-core owns fallback selection and strips the primary endpoint and
// credentials. The memory adapter passes `fallback: "none"` to this private
// factory, so do not test fallback activation by bypassing the adapter.
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import plugin from "../index.js";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";
import { LmstudioModelLoadError } from "./models.fetch.js";
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
const resolveApiKey = vi.hoisted(() => vi.fn(async (_params?: unknown) => undefined));
const embeddedModels = vi.hoisted(() => [] as string[]);
const createRemote = vi.hoisted(() =>
  vi.fn((params: { client: { model: string } }) => ({
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
  })),
);

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")
  >()),
  createRemoteEmbeddingProvider: createRemote,
}));

vi.mock("./models.fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models.fetch.js")>()),
  prepareLmstudioModelForInference: (params: { requestedContextLength?: number }) =>
    prepareModel(params),
  fetchLmstudioModels: (params: unknown) => fetchModels(params),
}));

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  resolveLmstudioRuntimeApiKey: (params: unknown) => resolveApiKey(params),
}));

const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

function requireEmbeddingAdapter() {
  const adapter = capturePluginRegistration(plugin).embeddingProviders[0];
  assert(adapter, "LM Studio did not register its embedding provider");
  return adapter;
}

function buildConfig(params: {
  model?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  providerId?: string;
}): OpenClawConfig {
  return createModelProviderConfig({
    [params.providerId ?? "lmstudio"]: {
      baseUrl: "http://localhost:1234/v1",
      models: [{ id: EMBEDDING_MODEL, ...params.model }],
      ...params.provider,
    },
  }) as unknown as OpenClawConfig;
}

function options(params: Parameters<typeof buildConfig>[0] = {}) {
  const provider = params.providerId ?? "lmstudio";
  return {
    config: buildConfig(params),
    provider,
    model: `${provider}/${params.model?.id ?? EMBEDDING_MODEL}`,
    fallback: "none",
  };
}

describe("createLmstudioEmbeddingProvider preload context length", () => {
  beforeEach(() => {
    prepareModel.mockClear();
    fetchModels.mockClear();
    fetchModels.mockResolvedValue({ reachable: true, status: 200, models: [] });
    createRemote.mockClear();
    embeddedModels.length = 0;
    resolveApiKey.mockClear();
  });

  it.each<[Record<string, number>, number | undefined]>([
    [{ contextTokens: 4096, contextWindow: 8192 }, 4096],
    [{ contextWindow: 8192 }, 8192],
    [{}, undefined],
  ])("selects preload context for %j", async (model, requestedContextLength) => {
    await createLmstudioEmbeddingProvider(options({ model }));
    expect(prepareModel).toHaveBeenCalledWith(expect.objectContaining({ requestedContextLength }));
  });

  it("keeps each query-batch service lease until its request settles", async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const acquireLocalService = vi
      .fn()
      .mockResolvedValueOnce({ release: firstRelease })
      .mockResolvedValueOnce({ release: secondRelease });
    const { promise: secondResult, resolve: resolveSecond } = Promise.withResolvers<number[]>();
    const remoteEmbed = vi
      .fn()
      .mockRejectedValueOnce(new Error("first query failed"))
      .mockImplementationOnce(async () => await secondResult);
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
    const { provider } = await createLmstudioEmbeddingProvider({
      ...options({
        provider: {
          params: { preload: false },
          localService: { command: "/usr/bin/lms" },
        },
      }),
      acquireLocalService,
    });
    const pending = provider.embedBatch(["first", "second"], { inputType: "query" });
    await expect(pending).rejects.toThrow("first query failed");
    expect(acquireLocalService).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    expect(remoteEmbedBatch).not.toHaveBeenCalled();
    resolveSecond([2]);
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
          selected_variant: requestedVariant,
        },
      ],
    });

    const result = await requireEmbeddingAdapter().create({
      ...options({
        model: { id: requestedVariant },
        provider: {
          params: { preload: false },
          localService: { command: "/usr/bin/lms" },
        },
      }),
      acquireLocalService,
    });
    assert(result.provider, "expected LM Studio embedding provider");
    expect(prepareModel).not.toHaveBeenCalled();
    expect(acquireLocalService).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(result.provider.model).toBe(EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toMatchObject({ model: EMBEDDING_MODEL });
    await result.provider.embed("hello", { inputType: "query" });
    expect(embeddedModels).toEqual([EMBEDDING_MODEL]);
    expect(acquireLocalService).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "keeps model identity when preload fails after discovery=%s",
    async (discovered) => {
      const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
      const cause = new Error("fixture preload rejected");
      prepareModel.mockRejectedValueOnce(
        discovered ? new LmstudioModelLoadError(EMBEDDING_MODEL, undefined, cause) : cause,
      );

      const result = await requireEmbeddingAdapter().create({
        ...options({ model: { id: requestedVariant } }),
      });

      const model = discovered ? EMBEDDING_MODEL : requestedVariant;
      expect(result.provider?.model).toBe(model);
      expect(result.runtime?.cacheKeyData).toMatchObject({ model });
    },
  );

  it.each([
    ["http://spark.local:1234/v1", "spark-key", "http://spark.local:1234/v1"],
    ["spark.local:1234/api/v1", undefined, "http://spark.local:1234/api/v1"],
  ])("leases the configured alias at %s", async (baseUrl, apiKey, targetUrl) => {
    const release = vi.fn();
    const acquireLocalService = vi.fn(async (_target: unknown) => ({ release }));
    const result = await requireEmbeddingAdapter().create({
      ...options({
        providerId: "lmstudio-spark",
        provider: { baseUrl, apiKey, localService: { command: "/usr/bin/lms-spark" } },
      }),
      acquireLocalService,
    });
    assert(result.provider, "expected LM Studio embedding provider");
    await result.provider.embed("hello", { inputType: "query" });
    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "lmstudio-spark",
      baseUrl: "http://spark.local:1234/v1",
      model: EMBEDDING_MODEL,
    });
    expect(prepareModel).toHaveBeenCalledWith(expect.objectContaining({ apiKey }));
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(acquireLocalService).toHaveBeenCalledTimes(2);
    for (const call of acquireLocalService.mock.calls) {
      expect(call).toEqual([
        {
          providerId: "lmstudio-spark",
          baseUrl: targetUrl,
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
        },
        undefined,
      ]);
    }
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("keeps API key rotation out of memory identity without dropping tenant headers", async () => {
    const readIdentity = async (headers: Record<string, string>) =>
      (
        await requireEmbeddingAdapter().create({
          ...options({ provider: { params: { preload: false } } }),
          remote: { headers },
        })
      ).runtime?.cacheKeyData;

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
