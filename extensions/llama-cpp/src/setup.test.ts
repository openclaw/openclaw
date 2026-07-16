import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
  DEFAULT_LLAMA_CPP_MODEL_REF,
  LLAMA_CPP_PROVIDER_ID,
} from "./defaults.js";

const nodeLlamaMocks = vi.hoisted(() => ({
  download: vi.fn(async () => "/models/default.gguf"),
  createModelDownloader: vi.fn(),
  resolveModelFile: vi.fn(),
}));

vi.mock("node-llama-cpp", () => ({
  createModelDownloader: nodeLlamaMocks.createModelDownloader,
  getLlama: vi.fn(),
  resolveModelFile: nodeLlamaMocks.resolveModelFile,
  LlamaChat: vi.fn(),
}));

import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./setup.js";

let tempRoot: string;
let cacheDir: string;

beforeEach(async () => {
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-cpp-setup-")));
  cacheDir = path.join(tempRoot, "models");
  await fs.mkdir(cacheDir);
  nodeLlamaMocks.download.mockReset().mockResolvedValue("/models/default.gguf");
  nodeLlamaMocks.createModelDownloader.mockReset().mockResolvedValue({
    download: nodeLlamaMocks.download,
  });
  nodeLlamaMocks.resolveModelFile.mockReset().mockImplementation(async (_source, options) => {
    const candidate = path.join(options.directory, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE);
    await fs.access(candidate);
    return candidate;
  });
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function configWithCache(): ProviderAppGuidedSetupContext["config"] {
  return {
    models: {
      providers: {
        [LLAMA_CPP_PROVIDER_ID]: {
          baseUrl: "local://llama-cpp",
          api: "openai-completions" as const,
          params: { modelCacheDir: cacheDir },
          models: [],
        },
      },
    },
  };
}

function createAuthContext(confirm: boolean): ProviderAuthContext {
  return {
    config: configWithCache(),
    prompter: {
      confirm: vi.fn(async () => confirm),
      note: vi.fn(async () => {}),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    },
    runtime: {},
  } as unknown as ProviderAuthContext;
}

describe("llama.cpp setup", () => {
  it("returns null when the configured model is not cached", async () => {
    await expect(detectLlamaCppSetup({ config: configWithCache(), env: {} })).resolves.toBeNull();
  });

  it("detects the cached default model without downloading", async () => {
    await fs.writeFile(path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE), "fixture");

    await expect(detectLlamaCppSetup({ config: configWithCache(), env: {} })).resolves.toEqual({
      modelRef: DEFAULT_LLAMA_CPP_MODEL_REF,
      detail: "qwen3-4b-instruct-2507-q4_k_m (downloaded)",
    });
    expect(nodeLlamaMocks.createModelDownloader).not.toHaveBeenCalled();
    expect(nodeLlamaMocks.resolveModelFile).toHaveBeenCalledWith(
      expect.stringMatching(/^hf:/),
      expect.objectContaining({ directory: cacheDir, download: false, cli: false }),
    );
  });

  it("uses node-llama-cpp cache resolution for a configured HF branch", async () => {
    const cachedPath = path.join(cacheDir, "hf_org_repo_release_model.gguf");
    await fs.writeFile(cachedPath, "fixture");
    nodeLlamaMocks.resolveModelFile.mockResolvedValueOnce(cachedPath);
    const config = configWithCache();
    const provider = config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    if (!provider) {
      throw new Error("expected llama.cpp provider config");
    }
    provider.models.push({
      id: "custom",
      name: "Custom",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
      params: { modelPath: "hf:org/repo/model.gguf#release" },
    });

    await expect(detectLlamaCppSetup({ config, env: {} })).resolves.toEqual({
      modelRef: "llama-cpp/custom",
      detail: "custom (downloaded)",
    });
    expect(nodeLlamaMocks.resolveModelFile).toHaveBeenCalledWith(
      "hf:org/repo/model.gguf#release",
      expect.objectContaining({ download: false, cli: false }),
    );
  });

  it("prepares config only for a currently cached detected model", async () => {
    await expect(
      prepareLlamaCppSetup({
        config: configWithCache(),
        env: {},
        modelRef: DEFAULT_LLAMA_CPP_MODEL_REF,
      }),
    ).resolves.toBeNull();

    await fs.writeFile(path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE), "fixture");
    await expect(
      prepareLlamaCppSetup({
        config: configWithCache(),
        env: {},
        modelRef: DEFAULT_LLAMA_CPP_MODEL_REF,
      }),
    ).resolves.toMatchObject({
      profiles: [],
      defaultModel: DEFAULT_LLAMA_CPP_MODEL_REF,
      configPatch: {
        models: {
          mode: "merge",
          providers: {
            [LLAMA_CPP_PROVIDER_ID]: {
              baseUrl: "local://llama-cpp",
              models: [expect.objectContaining({ id: "qwen3-4b-instruct-2507-q4_k_m" })],
            },
          },
        },
      },
    });
  });

  it("exits without config or download when consent is declined", async () => {
    const ctx = createAuthContext(false);

    await expect(runLlamaCppSetup(ctx)).resolves.toEqual({ profiles: [] });

    expect(ctx.prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("about 2.5 GB") }),
    );
    expect(nodeLlamaMocks.createModelDownloader).not.toHaveBeenCalled();
  });

  it("downloads after consent and returns the provider patch", async () => {
    const ctx = createAuthContext(true);

    await expect(runLlamaCppSetup(ctx)).resolves.toMatchObject({
      profiles: [],
      defaultModel: DEFAULT_LLAMA_CPP_MODEL_REF,
      configPatch: {
        models: {
          providers: {
            [LLAMA_CPP_PROVIDER_ID]: expect.objectContaining({
              baseUrl: "local://llama-cpp",
            }),
          },
        },
      },
    });

    expect(nodeLlamaMocks.createModelDownloader).toHaveBeenCalledWith(
      expect.objectContaining({
        dirPath: cacheDir,
        fileName: DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE,
        showCliProgress: false,
      }),
    );
    expect(nodeLlamaMocks.download).toHaveBeenCalledTimes(1);
  });
});
