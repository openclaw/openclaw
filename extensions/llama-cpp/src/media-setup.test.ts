import fs from "node:fs/promises";
import path from "node:path";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(async () => {
  vi.resetAllMocks();
  root = dirs.make("llama-media-setup-");
  preset = path.join(root, "candidate.ini");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  mocks.hardware.mockResolvedValue({
    platform: "linux",
    arch: "x64",
    accelerator: { kind: "cpu", reason: "No supported GPU" },
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 7 * GIB,
    availableDiskBytes: 20 * GIB,
    availableRuntimeDiskBytes: 20 * GIB,
    sharedDisk: true,
  });
  mocks.ensureModel.mockImplementation(async ({ source, download, signal }) => {
    signal?.throwIfAborted();
    if (!download) {
      throw new Error("not cached");
    }
    return path.join(root, source.includes("mmproj") ? "projector.gguf" : "model.gguf");
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
  let provider: ProviderPlugin | undefined;
  let media: MediaUnderstandingProvider | undefined;
  plugin.register(
    createTestPluginApi({
      id: "llama-cpp",
      name: "llama.cpp",
      source: "test",
      config: {},
      pluginConfig: {},
      registerProvider: (value) => {
        provider = value;
      },
      registerMediaUnderstandingProvider: (value) => {
        media = value;
      },
    }),
  );
  const method = provider?.auth.find((entry) => entry.id === "local-media");
  const ordinary = provider?.auth.find((entry) => entry.id === "local");
  if (!method || !ordinary || !media) {
    throw new Error("Missing production local media registration");
  }
  registeredMedia = media;
  setup = method.run;
  ordinarySetup = ordinary.run;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registered local media setup transaction", () => {
  it.each(["chat", "embedding-only"])(
    "retains working image routes, presets and residency through subsequent %s setup",
    async (mode) => {
      const actual =
        await vi.importActual<typeof import("./managed-server.js")>("./managed-server.js");
      let port = 20010;
      // Hardware, downloads and inference are mocked; the registered setup methods
      // and on-disk preset/config transitions use their real owners.
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
        const file = path.join(root, source.includes("mmproj") ? "projector.gguf" : "model.gguf");
        await fs.writeFile(file, "GGUF");
        return file;
      });
      const ctx = context();
      let chatDefault: string | undefined;
      if (mode === "chat") {
        mocks.hardware.mockResolvedValue({
          ...(await mocks.hardware()),
          totalMemoryBytes: 16 * GIB,
          availableMemoryBytes: 14 * GIB,
        });
        const initial = await ordinarySetup(ctx);
        expect(initial.defaultModel).toBeDefined();
        chatDefault = initial.defaultModel;
        ctx.config = { ...ctx.config, ...initial.configPatch };
        ctx.config.agents = { defaults: { model: { primary: initial.defaultModel } } };
      }
      const media = await setup(ctx);
      ctx.config = { ...ctx.config, ...media.configPatch };
      ctx.config.memory = { search: { provider: "local" } };
      const provider = ctx.config.models?.providers?.["llama-cpp"];
      const currentPreset = resolveLlamaCppPresetPath(provider?.localService);
      if (!provider?.localService || !currentPreset) {
        throw new Error("Missing installed media router");
      }
      provider.localService.env = { MODEL_SETTING: "retained" };
      provider.localService.cwd = root;
      provider.localService.readyTimeoutMs = 42000;
      provider.localService.idleStopMs = 1234;
      provider.localService.args?.push("--threads", "2");
      const customSection =
        "[operator-model]\n; keep operator settings\nmodel = /models/operator.gguf\n";
      await fs.appendFile(currentPreset, `\n${customSection}`);
      if (mode === "chat") {
        const chat = provider.models.find((model) => !model.input.includes("image"));
        if (!chat) {
          throw new Error("Missing installed chat model");
        }
        chat.baseUrl = provider.baseUrl;
        provider.models.push({ ...chat, id: "custom-route", baseUrl: "https://custom.example/v1" });
      } else {
        mocks.hardware.mockResolvedValue({
          ...(await mocks.hardware()),
          totalMemoryBytes: 7 * GIB,
          availableMemoryBytes: 6 * GIB,
        });
      }
      const before = structuredClone(ctx.config);
      const activePreset = await fs.readFile(currentPreset, "utf8");
      const result = await ordinarySetup(ctx);
      const updated = result.configPatch?.models?.providers?.["llama-cpp"];
      const nextPreset = resolveLlamaCppPresetPath(updated?.localService);
      if (!updated?.localService || !nextPreset) {
        throw new Error("Missing replacement router");
      }
      expect(ctx.config).toEqual(before);
      expect(result.configPatch?.agents).toBeUndefined();
      expect(result.configPatch?.tools).toBeUndefined();
      expect(result.configPatch?.memory).toBeUndefined();
      expect(result.defaultModel).toBe(chatDefault);
      expect(updated.baseUrl).not.toBe(provider.baseUrl);
      expect(updated.params).toEqual(provider.params);
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
      expect(rewritten).toContain(customSection);
      expect(rewritten).toContain("[embeddinggemma-300m-qat-q8_0]");
      ctx.config = { ...ctx.config, ...result.configPatch };
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
    const ctx = context(false);
    const before = structuredClone(ctx.config);
    expect(await setup(ctx)).toEqual({ profiles: [] });
    expect(ctx.config).toEqual(before);
    expect(mocks.ensureModel.mock.calls.every(([arg]) => arg.download === false)).toBe(true);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.inference).not.toHaveBeenCalled();
    expect(ctx.prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: false,
        message: expect.stringContaining("Original images remain available"),
      }),
    );
  });

  it("publishes only after both registered production routes see their real image fixtures", async () => {
    const ctx = context();
    const describeImage = vi.spyOn(registeredMedia, "describeImage");
    const result = await setup(ctx);
    expect(describeImage).toHaveBeenCalledTimes(2);
    expect(describeImage.mock.calls[0]?.[0].buffer).toEqual(LLAMA_CPP_OCR_FIXTURE);
    expect(describeImage.mock.calls[1]?.[0].buffer).toEqual(LLAMA_CPP_VISION_FIXTURE);
    expect(describeImage.mock.calls[0]?.[0].model).not.toBe(describeImage.mock.calls[1]?.[0].model);
    const provider = result.configPatch?.models?.providers?.["llama-cpp"];
    expect(provider?.models.map((model) => model.input)).toEqual([
      ["text", "image"],
      ["text", "image"],
    ]);
    expect(provider?.params?.mediaModels).toEqual({
      ocr: "glm-ocr-q8_0",
      vision: "smolvlm2-2.2b-instruct-q4_k_m",
    });
    expect(mocks.ensureModel.mock.calls.filter(([arg]) => arg.download)).toHaveLength(4);
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        chatModel: { mode: "preserve" },
        modelsMax: 1,
        isolated: true,
        mediaModels: expect.arrayContaining([
          expect.objectContaining({ projectorPath: expect.any(String), device: "none" }),
        ]),
      }),
    );
    expect(result.defaultModel).toBeUndefined();
    expect(ctx.config).toEqual({});
    expect(await fs.readFile(preset, "utf8")).toBe("candidate preset");
    const verificationDir = describeImage.mock.calls[0]?.[0].agentDir;
    expect(verificationDir).toBeTruthy();
    await expect(fs.stat(verificationDir!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { platform: "darwin" as const, arch: "arm64" },
    { platform: "win32" as const, arch: "x64" },
    { platform: "linux" as const, arch: "arm64" },
  ])(
    "leaves configuration untouched outside the verified Linux x64 scope: $platform/$arch",
    async ({ platform, arch }) => {
      const ctx = context();
      const before = structuredClone(ctx.config);
      mocks.hardware.mockResolvedValue({
        platform,
        arch,
        accelerator: { kind: "cpu", reason: "CPU host" },
        totalMemoryBytes: 16 * GIB,
        availableMemoryBytes: 15 * GIB,
        availableDiskBytes: 20 * GIB,
        availableRuntimeDiskBytes: 20 * GIB,
        sharedDisk: true,
      });

      await expect(setup(ctx)).resolves.toEqual({ profiles: [] });

      expect(ctx.prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("supports Linux x64 with CPU execution only"),
        "Local media unavailable",
      );
      expect(mocks.ensureModel).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.inference).not.toHaveBeenCalled();
      expect(ctx.config).toEqual(before);
    },
  );

  it.each(["ocr", "vision"])(
    "%s failure removes candidate state and never produces a patch",
    async (task) => {
      const ctx = context();
      const before = structuredClone(ctx.config);
      mocks.inference.mockImplementation(async (request) => ({
        text: request.model.startsWith("glm")
          ? task === "ocr"
            ? "4828"
            : "OPENCLAW OCR 4827"
          : "circle",
        model: request.model,
      }));
      await expect(setup(ctx)).rejects.toThrow(
        `${task.toUpperCase()} inference verification failed`,
      );
      expect(mocks.inference).toHaveBeenCalledTimes(task === "ocr" ? 1 : 2);
      expect(ctx.config).toEqual(before);
      await expect(fs.stat(preset)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves chat defaults, inventory, embeddings, provider settings and audio/video routes", async () => {
    const ctx = context();
    const describeImage = vi.spyOn(registeredMedia, "describeImage");
    const provider = buildLlamaCppProviderConfig({
      managed: {
        command: "/old/llama-server",
        baseUrl: "http://127.0.0.1:19432/v1",
        healthUrl: "http://127.0.0.1:19432/health",
        args: ["--models-preset", "/old/models.ini"],
      },
    });
    provider.params = { modelCacheDir: root, custom: "retained" };
    provider.headers = { "X-Custom": "retained" };
    if (provider.localService) {
      provider.localService.env = { CUSTOM_SETTING: "retained" };
      provider.localService.cwd = root;
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
    const result = await setup(ctx);
    expect(describeImage.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
      30_000, 30_000,
    ]);
    expect(ctx.config).toEqual(before);
    expect(result.configPatch?.agents?.defaults?.model).toEqual(before.agents?.defaults?.model);
    expect(result.configPatch?.models?.providers?.["llama-cpp"]?.models[0]).toEqual(
      provider.models[0],
    );
    expect(result.configPatch?.models?.providers?.["llama-cpp"]).toMatchObject({
      headers: provider.headers,
      params: { custom: "retained", modelCacheDir: root },
      localService: { env: { CUSTOM_SETTING: "retained" }, cwd: root },
    });
    expect(result.configPatch?.memory).toBeUndefined();
    expect(result.configPatch?.agents?.defaults?.imageModel).toEqual({
      primary: "llama-cpp/smolvlm2-2.2b-instruct-q4_k_m",
      fallbacks: [],
    });
    expect(result.configPatch?.tools?.media?.models).toEqual([
      { provider: "openai", model: "multimodal", capabilities: ["audio", "video"] },
      { provider: "llama-cpp", model: "smolvlm2-2.2b-instruct-q4_k_m", capabilities: ["image"] },
    ]);
  });

  it.each(["download", "startup", "ocr", "vision"])(
    "propagates cancellation during %s and keeps working configuration",
    async (stage) => {
      const controller = new AbortController();
      const ctx = { ...context(), signal: controller.signal };
      if (stage === "download") {
        mocks.ensureModel.mockImplementation(async ({ download, signal }) => {
          expect(signal).toBe(controller.signal);
          if (download) {
            controller.abort();
          }
          signal.throwIfAborted();
          throw new Error("not cached");
        });
      } else if (stage === "startup") {
        mocks.prepare.mockImplementation(async ({ signal }) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          signal.throwIfAborted();
        });
      } else {
        mocks.inference.mockImplementation(async (request) => {
          expect(request.signal).toBe(controller.signal);
          if ((stage === "ocr") === request.model.startsWith("glm")) {
            controller.abort();
            request.signal.throwIfAborted();
          }
          return { text: "OPENCLAW OCR 4827", model: request.model };
        });
      }
      await expect(setup(ctx)).rejects.toMatchObject({ name: "AbortError" });
      expect(ctx.config).toEqual({});
      await expect(fs.stat(preset)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("credits only verified model/projector cache on retry", async () => {
    mocks.ensureModel.mockImplementation(async ({ source }) =>
      path.join(root, source.includes("mmproj") ? "projector.gguf" : "model.gguf"),
    );
    const ctx = context();
    await setup(ctx);
    expect(mocks.ensureModel.mock.calls.filter(([arg]) => arg.download === false)).toHaveLength(
      LLAMA_CPP_MEDIA_RECIPES.length * 2,
    );
    expect(ctx.prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("(verified cache)") }),
    );
  });

  it("rebases managed model endpoints while preserving custom routes and chat defaults", async () => {
    const ctx = context();
    const provider = buildLlamaCppProviderConfig({
      managed: {
        command: "/old/llama-server",
        baseUrl: "http://127.0.0.1:19432/v1",
        healthUrl: "http://127.0.0.1:19432/health",
        args: ["--models-preset", "/old/models.ini"],
      },
    });
    const model = provider.models[0];
    if (!model) {
      throw new Error("Expected existing model fixture");
    }
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
    const result = await setup(ctx);
    const selected = result.configPatch?.models?.providers?.["llama-cpp"]?.models;
    expect(selected?.map(({ id, baseUrl }) => ({ id, baseUrl }))).toEqual([
      { id: "retained-chat", baseUrl: "http://127.0.0.1:20001/v1" },
      { id: "custom-chat", baseUrl: "https://custom.example/v1" },
      { id: "glm-ocr-q8_0", baseUrl: "http://127.0.0.1:20001/v1" },
      { id: "smolvlm2-2.2b-instruct-q4_k_m", baseUrl: "http://127.0.0.1:20001/v1" },
    ]);
    expect(result.configPatch?.agents?.defaults?.model).toEqual(before.agents?.defaults?.model);
    expect(ctx.config).toEqual(before);
  });

  it("rejects credential-only mode without downloading or partially installing routes", async () => {
    await expect(setup({ ...context(), credentialOnly: true })).rejects.toThrow(
      "without --credential-only",
    );
    expect(mocks.hardware).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it.each(["external", "direct-model"])(
    "leaves %s server ownership unchanged before downloads",
    async (mode) => {
      const ctx = context();
      const provider = buildLlamaCppProviderConfig();
      if (mode === "direct-model") {
        provider.localService = {
          command: "/custom/server",
          args: ["--model", "/custom/model.gguf"],
        };
      }
      ctx.config = { models: { providers: { "llama-cpp": provider } } };
      const before = structuredClone(ctx.config);
      await expect(setup(ctx)).rejects.toThrow("managed llama.cpp router");
      expect(ctx.config).toEqual(before);
      expect(mocks.ensureModel).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
    },
  );

  it("rejects implicit remote capabilities instead of inventing audio/video intent", async () => {
    const ctx = context();
    ctx.config = { tools: { media: { models: [{ provider: "openai", model: "vision" }] } } };
    await expect(setup(ctx)).rejects.toThrow("explicit capabilities");
    expect(mocks.ensureModel).not.toHaveBeenCalled();
  });
});
