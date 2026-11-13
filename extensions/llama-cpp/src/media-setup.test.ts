import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCapturedPluginRegistration,
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hardware: vi.fn(),
  ensureModel: vi.fn(),
  install: vi.fn(),
  prepare: vi.fn(),
  inference: vi.fn(),
}));
vi.mock("./hardware.js", async (original) => ({
  ...(await original<typeof import("./hardware.js")>()),
  detectLlamaCppHardware: mocks.hardware,
}));
vi.mock("./managed-server.js", async (original) => ({
  ...(await original<typeof import("./managed-server.js")>()),
  ensureLlamaCppModel: mocks.ensureModel,
  prepareManagedLlamaServer: mocks.prepare,
}));
vi.mock("./llama-server-install.js", async (original) => ({
  ...(await original<typeof import("./llama-server-install.js")>()),
  ensureLlamaServerInstalled: mocks.install,
}));
vi.mock("openclaw/plugin-sdk/media-understanding", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/media-understanding")>()),
  describeImagesWithModelPayloadTransform: mocks.inference,
}));
import plugin from "../index.js";
import { buildLlamaCppProviderConfig } from "./defaults.js";
import { resolveLlamaCppPresetPath } from "./managed-server.js";
import { LLAMA_CPP_MEDIA_RECIPES } from "./media-catalog.js";
import { LLAMA_CPP_OCR_FIXTURE, LLAMA_CPP_VISION_FIXTURE } from "./media-verification-fixtures.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const GIB = 1024 ** 3;
let root: string;
let preset: string;
let registeredMedia: MediaUnderstandingProvider;
let setup: ProviderPlugin["auth"][number]["run"];
let ordinarySetup: ProviderPlugin["auth"][number]["run"];
let ctx: ProviderAuthContext;

function context(consent = true): ProviderAuthContext {
  return {
    config: {},
    prompter: createTestWizardPrompter({ confirm: vi.fn(async () => consent) }),
    runtime: createRuntimeEnv(),
    isRemote: false,
    openUrl: async () => {
      throw new Error("Unexpected OAuth");
    },
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected OAuth");
      },
    },
  };
}

function managedProvider(args: string[] = []) {
  return buildLlamaCppProviderConfig({
    managed: {
      command: "/old/llama-server",
      baseUrl: "http://127.0.0.1:19432/v1",
      healthUrl: "http://127.0.0.1:19432/health",
      args: ["--models-preset", "/old/models.ini", ...args],
    },
  });
}

function expectNotCalled(...functions: Array<ReturnType<typeof vi.fn>>) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}

function modelFile(source: string) {
  return path.join(root, source.includes("mmproj") ? "projector.gguf" : "model.gguf");
}

function hardware(total = 8, available = 7, arch = "x64") {
  mocks.hardware.mockResolvedValue({
    platform: "linux",
    arch,
    accelerator: { kind: "cpu", reason: "No supported GPU" },
    totalMemoryBytes: total * GIB,
    availableMemoryBytes: available * GIB,
    availableDiskBytes: 20 * GIB,
    availableRuntimeDiskBytes: 20 * GIB,
    sharedDisk: true,
  });
}

async function unchangedSetup(authContext: ProviderAuthContext, run = setup) {
  const before = structuredClone(authContext.config);
  try {
    return await run(authContext);
  } finally {
    expect(authContext.config).toEqual(before);
  }
}

beforeEach(async () => {
  vi.resetAllMocks();
  root = dirs.make("llama-media-setup-");
  preset = path.join(root, "candidate.ini");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  hardware();
  mocks.ensureModel.mockImplementation(async ({ source, download, signal }) => {
    signal?.throwIfAborted();
    if (!download) {
      throw new Error("not cached");
    }
    return modelFile(source);
  });
  mocks.install.mockResolvedValue({ command: path.join(root, "llama-server") });
  mocks.prepare.mockImplementation(async () => {
    await fs.writeFile(preset, "candidate preset");
    return {
      command: path.join(root, "llama-server"),
      baseUrl: "http://127.0.0.1:20001/v1",
      healthUrl: "http://127.0.0.1:20001/health",
      args: ["--models-preset", preset, "--models-max", "1"],
    };
  });
  mocks.inference.mockImplementation(async (request) => ({
    text: request.model.startsWith("glm") ? "OPENCLAW OCR 4827" : "red square",
    model: request.model,
  }));
  const captured = createCapturedPluginRegistration({
    id: "llama-cpp",
    name: "llama.cpp",
    source: "test",
    config: {},
  });
  plugin.register(captured.api);
  const provider = captured.providers.at(-1);
  const media = captured.mediaUnderstandingProviders.at(-1);
  const method = provider?.auth.find((entry) => entry.id === "local-media");
  const ordinary = provider?.auth.find((entry) => entry.id === "local");
  assert(method && ordinary && media, "Missing production local media registration");
  registeredMedia = media;
  setup = method.run;
  ordinarySetup = ordinary.run;
  ctx = context();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["chat", "embedding-only"])(
  "retains working image routes, presets and residency through subsequent %s setup",
  async (mode) => {
    const actual =
      await vi.importActual<typeof import("./managed-server.js")>("./managed-server.js");
    let port = 20010;
    // Keep real preset/config transitions behind mocked hardware, downloads and inference.
    mocks.prepare.mockImplementation(
      (params: Parameters<typeof actual.prepareManagedLlamaServer>[0]) =>
        actual.prepareManagedLlamaServer({ ...params, port: port++ }),
    );
    const cached = new Set<string>();
    mocks.ensureModel.mockImplementation(async ({ source, download }) => {
      if (!download && !cached.has(source)) {
        throw new Error("not cached");
      }
      cached.add(source);
      const file = modelFile(source);
      await fs.writeFile(file, "GGUF");
      return file;
    });
    let chatDefault: string | undefined;
    if (mode === "chat") {
      hardware(16, 14);
      const initial = await ordinarySetup(ctx);
      expect(initial.defaultModel).toBeDefined();
      chatDefault = initial.defaultModel;
      ctx.config = applyProviderAuthConfigPatch(ctx.config, initial.configPatch, initial);
      ctx.config.agents = { defaults: { model: { primary: initial.defaultModel } } };
    }
    const media = await setup(ctx);
    ctx.config = applyProviderAuthConfigPatch(ctx.config, media.configPatch, media);
    ctx.config.memory = { search: { provider: "local" } };
    const provider = ctx.config.models?.providers?.["llama-cpp"];
    const currentPreset = resolveLlamaCppPresetPath(provider?.localService);
    assert(provider?.localService && currentPreset, "Missing installed media router");
    provider.localService.env = { MODEL_SETTING: "retained" };
    provider.localService.cwd = root;
    provider.localService.readyTimeoutMs = 42000;
    provider.localService.idleStopMs = 1234;
    provider.localService.args?.push("--threads", "2");
    const customSection =
      "[operator-model]\n; keep operator settings\nmodel = /models/operator.gguf\n";
    await fs.appendFile(currentPreset, `\n[*]\nthreads = 2\n\n${customSection}`);
    if (mode === "chat") {
      const chat = provider.models.find((model) => !model.input.includes("image"));
      assert(chat, "Missing installed chat model");
      chat.baseUrl = provider.baseUrl;
      provider.models.push({ ...chat, id: "custom-route", baseUrl: "https://custom.example/v1" });
    } else {
      hardware(7, 6);
    }
    const activePreset = await fs.readFile(currentPreset, "utf8");
    const result = await unchangedSetup(ctx, ordinarySetup);
    const updated = result.configPatch?.models?.providers?.["llama-cpp"];
    const nextPreset = resolveLlamaCppPresetPath(updated?.localService);
    assert(updated?.localService && nextPreset, "Missing replacement router");
    expect(result.configPatch?.agents).toBeUndefined();
    expect(result.configPatch?.tools).toBeUndefined();
    expect(result.configPatch?.memory).toBeUndefined();
    expect(result.defaultModel).toBe(chatDefault);
    expect(updated.baseUrl).not.toBe(provider.baseUrl);
    expect(updated.params).toEqual(provider.params);
    assert(updated.models, "Missing replacement router models");
    expect(updated.models.map((model) => model.id)).toEqual(
      provider.models.map((model) => model.id),
    );
    for (const model of updated.models) {
      expect(model.baseUrl).toBe(
        model.id === "custom-route" ? "https://custom.example/v1" : updated.baseUrl,
      );
    }
    expect(updated.localService).toMatchObject({
      env: { MODEL_SETTING: "retained" },
      cwd: root,
      readyTimeoutMs: 42000,
      idleStopMs: 1234,
    });
    expect(updated.localService.args).toEqual(expect.arrayContaining(["--threads", "2"]));
    const limit = updated.localService.args?.indexOf("--models-max") ?? -1;
    expect(limit).toBeGreaterThanOrEqual(0);
    expect(updated.localService.args?.[limit + 1]).toBe("1");
    expect(nextPreset).not.toBe(currentPreset);
    expect(await fs.readFile(currentPreset, "utf8")).toBe(activePreset);
    const rewritten = await fs.readFile(nextPreset, "utf8");
    expect(rewritten).not.toContain(customSection);
    expect(rewritten).toContain("threads = 2");
    expect(rewritten).toContain("[embeddinggemma-300m-qat-q8_0]");
    ctx.config = applyProviderAuthConfigPatch(ctx.config, result.configPatch, result);
    for (const recipe of LLAMA_CPP_MEDIA_RECIPES) {
      expect(rewritten).toContain(`[${recipe.id}]`);
      expect(rewritten).toContain(`mmproj = ${path.join(root, "projector.gguf")}`);
      await expect(
        registeredMedia.describeImage?.({
          cfg: ctx.config,
          agentDir: root,
          provider: "llama-cpp",
          model: recipe.id,
          buffer: recipe.capability === "ocr" ? LLAMA_CPP_OCR_FIXTURE : LLAMA_CPP_VISION_FIXTURE,
          fileName: "fixture.png",
          mime: "image/png",
          prompt: "Describe the image.",
          timeoutMs: 1000,
        }),
      ).resolves.toMatchObject({ model: recipe.id });
    }
    expect(mocks.inference).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfg: ctx.config }),
      expect.any(Function),
    );
  },
);

it("declining consent neither downloads nor prepares or changes configuration", async () => {
  ctx = context(false);
  expect(await unchangedSetup(ctx)).toEqual({ profiles: [] });
  expect(mocks.ensureModel.mock.calls.every(([arg]) => arg.download === false)).toBe(true);
  expectNotCalled(mocks.install, mocks.prepare, mocks.inference);
  expect(ctx.prompter.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      initialValue: false,
      message: expect.stringContaining("Original images remain available"),
    }),
  );
});

it("leaves configuration untouched outside the verified Linux x64 scope", async () => {
  hardware(16, 15, "arm64");
  await expect(unchangedSetup(ctx)).resolves.toEqual({ profiles: [] });
  expect(ctx.prompter.note).toHaveBeenCalledWith(
    expect.stringContaining("supports Linux x64 with CPU execution only"),
    "Local media unavailable",
  );
  expectNotCalled(mocks.ensureModel, mocks.install, mocks.prepare, mocks.inference);
});

it.each(["failure", "cancellation"])(
  "removes candidate state after vision %s without changing configuration",
  async (outcome) => {
    const controller = new AbortController();
    ctx.signal = controller.signal;
    mocks.inference.mockImplementation(async (request) => {
      if (outcome === "cancellation") {
        expect(request.signal).toBe(controller.signal);
        if (!request.model.startsWith("glm")) {
          controller.abort();
          request.signal.throwIfAborted();
        }
      }
      return {
        text: request.model.startsWith("glm") ? "OPENCLAW OCR 4827" : "circle",
        model: request.model,
      };
    });
    const result = unchangedSetup(ctx);
    if (outcome === "failure") {
      await expect(result).rejects.toThrow("VISION inference verification failed");
      expect(mocks.inference).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
    }
    await expect(fs.stat(preset)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("preserves chat defaults, inventory, embeddings, provider settings and audio/video routes", async () => {
  const describeImage = vi.spyOn(registeredMedia, "describeImage");
  const provider = managedProvider();
  provider.params = { modelCacheDir: root, custom: "retained" };
  provider.headers = { "X-Custom": "retained" };
  if (provider.localService) {
    provider.localService.env = { CUSTOM_SETTING: "retained" };
    provider.localService.cwd = root;
    provider.localService.args?.push("--image-max-tokens", "512", "-c", "4096", "-np", "1");
  }
  ctx.config = {
    models: { providers: { "llama-cpp": provider } },
    agents: {
      defaults: {
        model: { primary: "llama-cpp/existing-chat", fallbacks: ["openai/chat"] },
        imageModel: { primary: "openai/vision", fallbacks: ["anthropic/vision"] },
      },
    },
    memory: { search: { provider: "local", local: { modelPath: "/old/embedding.gguf" } } },
    tools: {
      media: {
        image: { timeoutSeconds: 30 },
        models: [
          { provider: "openai", model: "multimodal", capabilities: ["image", "audio", "video"] },
          { provider: "anthropic", model: "vision", capabilities: ["image"] },
        ],
      },
    },
  };
  const before = structuredClone(ctx.config);
  const { configPatch: patch } = await unchangedSetup(ctx);
  expect(describeImage.mock.calls.map(([request]) => request.timeoutMs)).toEqual([30_000, 30_000]);
  expect(patch?.agents?.defaults?.model).toEqual(before.agents?.defaults?.model);
  expect(patch?.models?.providers?.["llama-cpp"]?.models?.[0]).toEqual(provider.models[0]);
  expect(patch?.models?.providers?.["llama-cpp"]).toMatchObject({
    headers: provider.headers,
    params: { custom: "retained", modelCacheDir: root },
    localService: { env: { CUSTOM_SETTING: "retained" }, cwd: root },
  });
  expect(patch?.memory).toBeUndefined();
  expect(patch?.agents?.defaults?.imageModel).toEqual({
    primary: "llama-cpp/smolvlm2-2.2b-instruct-q4_k_m",
    fallbacks: [],
  });
  expect(patch?.tools?.media?.models).toEqual([
    { provider: "openai", model: "multimodal", capabilities: ["audio", "video"] },
    { provider: "llama-cpp", model: "smolvlm2-2.2b-instruct-q4_k_m", capabilities: ["image"] },
  ]);
});

it("credits only verified model/projector cache on retry", async () => {
  mocks.ensureModel.mockImplementation(async ({ source }) => modelFile(source));
  await setup(ctx);
  expect(mocks.ensureModel.mock.calls.filter(([arg]) => arg.download === false)).toHaveLength(
    LLAMA_CPP_MEDIA_RECIPES.length * 2,
  );
  expect(ctx.prompter.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("(verified cache)") }),
  );
});

it("rebases managed model endpoints while preserving custom routes and chat defaults", async () => {
  const provider = managedProvider();
  const model = provider.models[0];
  assert(model, "Expected existing model fixture");
  provider.models = [
    { ...model, id: "glm-ocr-q8_0", baseUrl: "https://old.example/v1" },
    { ...model, id: "retained-chat", baseUrl: provider.baseUrl },
    { ...model, id: "custom-chat", baseUrl: "https://custom.example/v1" },
  ];
  ctx.config = {
    models: { providers: { "llama-cpp": provider } },
    agents: {
      defaults: {
        model: { primary: "llama-cpp/retained-chat", fallbacks: ["llama-cpp/custom-chat"] },
      },
    },
  };
  const before = structuredClone(ctx.config);
  const result = await unchangedSetup(ctx);
  const selected = result.configPatch?.models?.providers?.["llama-cpp"]?.models;
  expect(selected?.map(({ id, baseUrl }) => ({ id, baseUrl }))).toEqual([
    { id: "retained-chat", baseUrl: "http://127.0.0.1:20001/v1" },
    { id: "custom-chat", baseUrl: "https://custom.example/v1" },
    { id: "glm-ocr-q8_0", baseUrl: "http://127.0.0.1:20001/v1" },
    { id: "smolvlm2-2.2b-instruct-q4_k_m", baseUrl: "http://127.0.0.1:20001/v1" },
  ]);
  expect(result.configPatch?.agents?.defaults?.model).toEqual(before.agents?.defaults?.model);
});

it("rejects credential-only mode without downloading or partially installing routes", async () => {
  await expect(setup({ ...context(), credentialOnly: true })).rejects.toThrow(
    "without --credential-only",
  );
  expectNotCalled(mocks.hardware, mocks.install);
});

it.each(["external", "direct-model"])(
  "leaves %s server ownership unchanged before downloads",
  async (mode) => {
    const provider = buildLlamaCppProviderConfig();
    if (mode === "direct-model") {
      provider.localService = {
        command: "/custom/server",
        args: ["--model", "/custom/model.gguf"],
      };
    }
    ctx.config = { models: { providers: { "llama-cpp": provider } } };
    await expect(unchangedSetup(ctx)).rejects.toThrow("managed llama.cpp router");
    expectNotCalled(mocks.ensureModel, mocks.install);
  },
);

it.each([["-np", "4"]])(
  "rejects inherited router limits before downloading: %j",
  async (...args) => {
    const provider = managedProvider(args);
    ctx.config = { models: { providers: { "llama-cpp": provider } } };
    await expect(setup(ctx)).rejects.toThrow("exceeds the local media limit");
    expect(mocks.ensureModel.mock.calls.every(([arg]) => arg.download === false)).toBe(true);
    expectNotCalled(mocks.install, mocks.prepare);
  },
);

it("rejects implicit remote capabilities instead of inventing audio/video intent", async () => {
  ctx.config = { tools: { media: { models: [{ provider: "openai", model: "vision" }] } } };
  await expect(setup(ctx)).rejects.toThrow("explicit capabilities");
  expect(mocks.ensureModel).not.toHaveBeenCalled();
});
