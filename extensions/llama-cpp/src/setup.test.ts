import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_ID,
  DEFAULT_LLAMA_CPP_MODEL_SHA256,
  DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES,
  DEFAULT_LLAMA_CPP_MODEL_URI,
  LLAMA_CPP_PROVIDER_ID,
} from "./defaults.js";
import type { LlamaDownloadProgress } from "./llama-server-install.js";
import { resolveLlamaCppModelCandidates } from "./model-catalog.js";
import { authContext, config, GIB, mocks, modelPath, tempRoot } from "./setup.test-support.js";

const { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } = await import("./setup.js");
const { downloadVerifiedFile } = await import("./llama-server-install.js");

const CUSTOM_EMBEDDING_MODEL =
  "hf:ggml-org/embeddinggemma-300M-qat-q4_0-GGUF/embeddinggemma-300M-qat-Q4_0.gguf";
const OTHER_CUSTOM_EMBEDDING_MODEL = "hf:example/other-embedding-GGUF/other-Q4_K_M.gguf";
function localMemory(embeddingPath?: string) {
  return {
    search: {
      provider: "local" as const,
      ...(embeddingPath && { local: { modelPath: embeddingPath } }),
    },
  };
}
function requestUnconfiguredLocalMemory(ctx: ProviderAuthContext, embeddingPath?: string): void {
  ctx.config.memory = localMemory(embeddingPath);
  delete ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
}
function providerFor(cfg: ProviderAuthContext["config"]) {
  const provider = cfg.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  assert.ok(provider, "missing fixture provider");
  return provider;
}
function makeModel(
  id: string,
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    ...overrides,
  };
}
function localService(prefix = ""): {
  command: string;
  args: [string, string];
  healthUrl: string;
} {
  return {
    command: path.join(tempRoot, `${prefix}llama-server`),
    args: ["--models-preset", path.join(tempRoot, `${prefix}models.ini`)],
    healthUrl: "http://127.0.0.1:19432/health",
  };
}
async function installedConfig() {
  const cfg = config();
  const provider = providerFor(cfg);
  const service = (provider.localService = localService());
  await Promise.all([
    fs.writeFile(service.command, "binary"),
    fs.writeFile(service.args[1], "version = 1"),
    fs.writeFile(modelPath, "GGUF"),
  ]);
  return cfg;
}
function expectConfirmation(ctx: ProviderAuthContext, message: string) {
  expect(ctx.prompter.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining(message) }),
  );
}
function expectNoDownload() {
  expect(mocks.ensureModel).not.toHaveBeenCalledWith(expect.objectContaining({ download: true }));
}
function expectPrepared(properties: Record<string, unknown>) {
  expect(mocks.prepareServer).toHaveBeenCalledWith(expect.objectContaining(properties));
}
async function expectSkipped(ctx: ProviderAuthContext, reason: string | RegExp) {
  await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
  expect(ctx.prompter.note).toHaveBeenCalledWith(
    typeof reason === "string" ? expect.stringContaining(reason) : expect.stringMatching(reason),
    "Setup skipped",
  );
  expect(ctx.prompter.confirm).not.toHaveBeenCalled();
}

describe("llama.cpp managed setup", () => {
  it("reports producer download rates during setup across an established shared tick", async () => {
    const times = [1010, 1010, 1030];
    vi.mocked(os.totalmem).mockReturnValue(4 * GIB);
    const ctx = authContext(true);
    requestUnconfiguredLocalMemory(ctx, CUSTOM_EMBEDDING_MODEL);
    const stopped = vi.fn();
    vi.mocked(ctx.prompter.progress).mockReturnValue({
      update: mocks.progressUpdate,
      stop: stopped,
    });
    const destination = path.join(tempRoot, "rate-embedding.gguf");
    const chunks = [1, 2, 3].map((value) => Buffer.alloc(1_000_000, value));
    const payload = Buffer.concat(chunks);
    const observations: Array<Parameters<LlamaDownloadProgress>[0] & { text: string }> = [];
    const release = vi.fn();
    const existingEnsure = mocks.ensureModel.getMockImplementation()!;
    mocks.ensureModel.mockImplementation(
      async (options: Parameters<typeof import("./managed-server.js").ensureLlamaCppModel>[0]) => {
        if (!options.download || options.source !== CUSTOM_EMBEDDING_MODEL) {
          return existingEnsure(options);
        }
        const report = options.onProgress;
        if (!report) {
          throw new Error("Selected setup download has no progress callback");
        }
        mocks.downloadFetch.mockResolvedValueOnce({
          response: new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) {
                  controller.enqueue(chunk);
                }
                controller.close();
              },
            }),
          ),
          release,
        });
        const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
        const actualOpen = fs.open.bind(fs);
        let written = 0;
        const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await actualOpen(...args);
          const writeFile = handle.writeFile.bind(handle);
          handle.writeFile = async (...writeArgs) => {
            await writeFile(...writeArgs);
            clock.mockReturnValue(times[written++]!);
          };
          return handle;
        });
        try {
          await downloadVerifiedFile({
            url: "https://downloads.example/rate-embedding.gguf",
            destination,
            expectedSize: payload.byteLength,
            expectedSha256: createHash("sha256").update(payload).digest("hex"),
            onProgress: (progress) => {
              expect(stopped).not.toHaveBeenCalled();
              report(progress);
              const text = mocks.progressUpdate.mock.lastCall?.[0];
              expect(typeof text).toBe("string");
              observations.push({ ...progress, text });
            },
          });
        } finally {
          opened.mockRestore();
          clock.mockRestore();
        }
        return destination;
      },
    );
    await runLlamaCppSetup(ctx);
    assert.deepStrictEqual(await fs.readFile(destination), payload);
    expect(release).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledExactlyOnceWith("Managed llama.cpp server prepared");
    expect(mocks.downloadFetch).toHaveBeenCalledOnce();
    expect(
      observations.map(({ downloadedSize, totalSize, bytesPerSecond, text }) => [
        downloadedSize,
        totalSize,
        bytesPerSecond,
        Number(text.match(/, (\d+) MB\/s\)$/u)?.[1]),
      ]),
    ).toEqual([
      [1_000_000, 3_000_000, 100_000_000, 100],
      [2_000_000, 3_000_000, 100_000_000, 100],
      [3_000_000, 3_000_000, 100_000_000, 100],
    ]);
    expect(
      observations.every((progress) =>
        progress.text.startsWith("Downloading configured embedding model…"),
      ),
    ).toBe(true);
  });

  it("reuses a downloaded recommendation after cancelled activation with little free disk", async () => {
    mocks.hardware.mockResolvedValue({
      platform: "darwin",
      arch: "arm64",
      accelerator: { kind: "metal" },
      totalMemoryBytes: 8 * GIB,
      availableMemoryBytes: 8 * GIB,
      availableDiskBytes: 3 * GIB,
      availableRuntimeDiskBytes: 3 * GIB,
      sharedDisk: true,
    });
    const recipe = resolveLlamaCppModelCandidates(await mocks.hardware(), "metal").recipes.at(-1)!;
    mocks.ensureModel.mockImplementation(async ({ source, cacheDir }) => {
      if (cacheDir !== tempRoot) {
        throw new Error("not cached here");
      }
      if (source === recipe.model.params?.modelPath) {
        return modelPath;
      }
      if (source === DEFAULT_LLAMA_CPP_EMBEDDING_MODEL) {
        return path.join(tempRoot, "embedding.gguf");
      }
      throw new Error("not cached");
    });
    const ctx = authContext(true);
    const provider = providerFor(ctx.config);
    provider.localService = { command: path.join(tempRoot, "llama-server") };
    const result = await runLlamaCppSetup(ctx);
    expect(result.defaultModel).toBe(`llama-cpp/${recipe.model.id}`);
    expectConfirmation(ctx, `Use cached ${recipe.model.name}`);
    expectPrepared({
      chatModel: expect.objectContaining({ id: recipe.model.id, path: modelPath }),
    });
  });

  it("makes CPU execution explicit when the NVIDIA host lacks a verified CUDA build", async () => {
    mocks.hardware.mockResolvedValue({
      platform: "linux",
      arch: "x64",
      totalMemoryBytes: 64 * GIB,
      availableMemoryBytes: 60 * GIB,
      availableDiskBytes: 100 * GIB,
      availableRuntimeDiskBytes: 100 * GIB,
      sharedDisk: true,
      accelerator: {
        kind: "cuda",
        devices: [
          {
            name: "GPU",
            totalMemoryBytes: 48 * GIB,
            availableMemoryBytes: 48 * GIB,
            driverVersion: "580.65",
          },
        ],
      },
    });
    const ctx = authContext(false);
    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
    expectConfirmation(ctx, "This recommendation uses CPU execution");
    expectConfirmation(ctx, "verified CPU runtime");
    expect(mocks.prepareServer).not.toHaveBeenCalled();
    expectNoDownload();
  });

  it("keeps the current model and credentials intact when preparation fails", async () => {
    const ctx = authContext(true);
    ctx.config.agents = { defaults: { model: { primary: "openai/gpt-5.4" } } };
    const previous = structuredClone(ctx.config);
    mocks.prepareServer.mockRejectedValue(new Error("runtime installation failed"));
    await expect(runLlamaCppSetup(ctx)).rejects.toThrow("runtime installation failed");
    expect(ctx.config).toEqual(previous);
    expect(mocks.removeProfiles).not.toHaveBeenCalled();
  });

  it("does not suggest retrying setup on a host the verified build cannot run on", async () => {
    const ctx = authContext(true);
    const { UnsupportedLlamaServerHostError } = await import("./llama-server-install.js");
    mocks.prepareServer.mockRejectedValue(
      new UnsupportedLlamaServerHostError("The verified llama-server build requires macOS 13.3+"),
    );
    const setup = runLlamaCppSetup(ctx);
    await expect(setup).rejects.toThrow(
      "Managed llama.cpp setup is unavailable on this host. The verified llama-server build requires macOS 13.3+",
    );
    await expect(setup).rejects.not.toThrow("retry");
  });

  it("refuses an unsupported host before downloading any model files", async () => {
    const ctx = authContext(true);
    const { UnsupportedLlamaServerHostError } = await import("./llama-server-install.js");
    mocks.ensureServerInstalled.mockRejectedValueOnce(
      new UnsupportedLlamaServerHostError(
        "The verified llama-server build requires macOS 13.3+; this Mac runs macOS 12.7.6.",
      ),
    );
    await expect(runLlamaCppSetup(ctx)).rejects.toThrow(
      "Managed llama.cpp setup is unavailable on this host. The verified llama-server build requires macOS 13.3+; this Mac runs macOS 12.7.6.",
    );
    expectNoDownload();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });

  it("pins the default model identity and integrity", () => {
    expect(DEFAULT_LLAMA_CPP_MODEL_URI).toBe(
      "hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf",
    );
    expect(DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES).toBe(4_977_171_584);
    expect(DEFAULT_LLAMA_CPP_MODEL_SHA256).toMatch(/^[a-f\d]{64}$/u);
  });

  it("keeps app discovery read-only", async () => {
    await expect(detectLlamaCppSetup({ config: config(), env: {} })).resolves.toBeNull();
    expectNoDownload();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });

  it("detects a fully prepared managed server", async () => {
    const cfg = await installedConfig();
    providerFor(cfg).models[0] = makeModel("custom", { name: "Custom", params: { modelPath } });
    await expect(detectLlamaCppSetup({ config: cfg, env: {} })).resolves.toEqual({
      modelRef: "llama-cpp/custom",
      detail: "Managed llama.cpp server ready",
    });
  });

  it("does not detect chat from a cached model when the managed inventory is empty", async () => {
    const cfg = await installedConfig();
    const cachedDefault = path.join(tempRoot, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE);
    await fs.writeFile(cachedDefault, "GGUF");
    await expect(detectLlamaCppSetup({ config: cfg, env: {} })).resolves.toBeNull();
    await expect(
      prepareLlamaCppSetup({
        config: cfg,
        env: {},
        modelRef: `${LLAMA_CPP_PROVIDER_ID}/${DEFAULT_LLAMA_CPP_MODEL_ID}`,
      }),
    ).resolves.toBeNull();
  });

  it("does not offer installed OCR or vision models as a chat setup candidate", async () => {
    const cfg = await installedConfig();
    const provider = providerFor(cfg);
    provider.params = {
      ...provider.params,
      mediaModels: { ocr: "ocr-model", vision: "vision-model" },
    };
    provider.models = ["ocr-model", "vision-model"].map((id) =>
      makeModel(id, { input: ["text", "image"], params: { modelPath } }),
    );
    await expect(detectLlamaCppSetup({ config: cfg, env: {} })).resolves.toBeNull();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });

  it("does not offer the default download below the RAM floor", async () => {
    vi.mocked(os.totalmem).mockReturnValue(4 * GIB);
    const ctx = authContext(true);
    await expectSkipped(
      ctx,
      /embedding-only.*0\.3 GB.*memory\.search\.provider.*local.*models auth login --provider llama-cpp --method local/su,
    );
    expectNoDownload();
  });

  it("uses the configured embedding model during chat setup", async () => {
    vi.mocked(os.totalmem).mockReturnValue(16 * GIB);
    const ctx = authContext(true);
    requestUnconfiguredLocalMemory(ctx, CUSTOM_EMBEDDING_MODEL);
    ctx.config.agents = {
      entries: {
        alpha: { memory: localMemory() },
        beta: { memory: localMemory() },
      },
    };
    await runLlamaCppSetup(ctx);
    expectConfirmation(ctx, "your configured local embedding model");
    expect(mocks.ensureModel).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CUSTOM_EMBEDDING_MODEL,
        download: true,
      }),
    );
    expectPrepared({ embeddingModelPath: path.join(tempRoot, "embedding.gguf") });
    const customDownload = mocks.ensureModel.mock.calls.find(
      ([options]) => options.source === CUSTOM_EMBEDDING_MODEL && options.download === true,
    );
    if (!customDownload) {
      throw new Error("configured embedding download was not requested");
    }
    customDownload[0].onProgress({
      downloadedSize: 150_000_000,
      totalSize: 300_000_000,
      bytesPerSecond: 12_000_000,
    });
    expect(mocks.progressUpdate).toHaveBeenCalledWith(
      expect.stringContaining("Downloading configured embedding model"),
    );
  });

  it("requires consent before embedding-only setup", async () => {
    vi.mocked(os.totalmem).mockReturnValue(4 * GIB);
    const ctx = authContext(false);
    requestUnconfiguredLocalMemory(ctx);
    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
    expectConfirmation(ctx, "only the local embedding model");
    expectNoDownload();
  });

  it("stops embedding-only setup when local-memory agents use different models", async () => {
    vi.mocked(os.totalmem).mockReturnValue(4 * GIB);
    const ctx = authContext(true);
    delete ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    ctx.config.agents = {
      entries: {
        alpha: { memory: localMemory(CUSTOM_EMBEDDING_MODEL) },
        beta: { memory: localMemory(OTHER_CUSTOM_EMBEDDING_MODEL) },
      },
    };
    await expectSkipped(ctx, "different local embedding models");
    expectNoDownload();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
    expect(mocks.removeProfiles).not.toHaveBeenCalled();
  });

  it("does not replace an external llama.cpp provider used as an agent primary", async () => {
    vi.mocked(os.totalmem).mockReturnValue(4 * GIB);
    const ctx = authContext(true);
    ctx.config.memory = { search: { provider: "local" } };
    ctx.config.agents = {
      defaults: { model: { primary: "openai/gpt-5.4" } },
      entries: { helper: { model: { primary: "llama-cpp/external-chat" } } },
    };
    const provider = providerFor(ctx.config);
    provider.models = [makeModel("external-chat", { name: "External chat" })];
    await expectSkipped(ctx, "existing llama.cpp server");
    expectNoDownload();
    expect(ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID]).toBe(provider);
  });

  it("does not replace a managed llama.cpp provider used as an agent subagent model", async () => {
    vi.mocked(os.totalmem).mockReturnValue(4 * GIB);
    const ctx = authContext(true);
    ctx.config.memory = { search: { provider: "local" } };
    ctx.config.agents = {
      defaults: { model: { primary: "openai/gpt-5.4" } },
      entries: { helper: { subagents: { model: "llama-cpp/external-chat" } } },
    };
    const provider = providerFor(ctx.config);
    provider.localService = localService();
    provider.models = [makeModel("external-chat", { name: "Managed chat" })];
    await expectSkipped(ctx, "Check params.modelPath");
    expect(ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID]).toBe(provider);
  });

  it("requires consent before installing and downloading", async () => {
    const ctx = authContext(false);
    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });
    expectConfirmation(ctx, "verified METAL runtime");
    expectNoDownload();
  });

  it("preserves custom model config when refreshing an existing managed server", async () => {
    const customModelPath = path.join(tempRoot, "custom.gguf");
    await fs.writeFile(customModelPath, "GGUF");
    const ctx = authContext(true);
    const provider = providerFor(ctx.config);
    provider.localService = localService("old-");
    provider.timeoutSeconds = 321;
    provider.models = [
      makeModel("custom", {
        name: "Custom model",
        reasoning: true,
        contextWindow: 32_768,
        maxTokens: 4096,
        params: { modelPath: customModelPath, contextSize: 16_384 },
      }),
    ];
    const result = await runLlamaCppSetup(ctx);
    const managed = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(managed?.timeoutSeconds).toBe(321);
    expect(managed?.models[0]).toEqual(provider.models[0]);
    expectPrepared({
      chatModel: expect.objectContaining({
        mode: "configure",
        id: "custom",
        path: customModelPath,
      }),
    });
  });

  it("replaces external endpoint state when switching to managed setup", async () => {
    const ctx = authContext(true);
    ctx.agentDir = path.join(tempRoot, "agent");
    ctx.config.auth = {
      profiles: { "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" } },
      order: { "llama-cpp": ["llama-cpp:default"] },
    };
    const provider = providerFor(ctx.config);
    provider.baseUrl = "http://127.0.0.1:8080/v1";
    provider.apiKey = "external-key";
    provider.auth = "api-key";
    provider.headers = { Authorization: "Bearer external-header" };
    provider.params = { endpointOnly: true };
    provider.models = [makeModel("external-model", { name: "External model" })];
    const result = await runLlamaCppSetup(ctx);
    const managed = result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expect(managed).toMatchObject({
      baseUrl: "http://127.0.0.1:19432/v1",
      localService: { command: path.join(tempRoot, "llama-server") },
    });
    expect(managed).not.toHaveProperty("apiKey");
    expect(managed).not.toHaveProperty("auth");
    expect(managed).not.toHaveProperty("headers");
    expect(managed).not.toHaveProperty("params");
    expect(managed?.models.some((model) => model.id === "external-model")).toBe(false);
    expect(result.configPatch?.auth).toEqual({
      profiles: { "llama-cpp:default": undefined },
      order: { "llama-cpp": undefined },
    });
    expect(mocks.removeProfiles).not.toHaveBeenCalled();
    expectPrepared({ isolated: true });
    expect(mocks.ensureModel).toHaveBeenCalledWith(
      expect.not.objectContaining({ cacheDir: tempRoot }),
    );
  });
});
