import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ImageDescriptionRequest,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { encodePngRgba } from "openclaw/plugin-sdk/test-media-generation";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  LLAMA_CPP_MEDIA_MAX_BYTES,
  LLAMA_CPP_MEDIA_MAX_TOKENS,
  LLAMA_CPP_MEDIA_TIMEOUT_MS,
} from "./media-config.js";
import { registerLlamaCppMediaTool } from "./media-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const IMAGE = encodePngRgba(Buffer.from([255, 0, 0, 255]), 1, 1);

function configured(): OpenClawConfig {
  return {
    models: {
      providers: {
        "llama-cpp": {
          baseUrl: "http://127.0.0.1:19432/v1",
          localService: { command: "/runtime/llama-server" },
          params: { mediaModels: { ocr: "local-ocr", vision: "local-vision" } },
          models: ["local-ocr", "local-vision"].map((id) => ({
            id,
            name: id,
            input: ["text", "image"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          })),
        },
      },
    },
  };
}

function capture(ctx: OpenClawPluginToolContext = {}, cfg = configured()) {
  const loadWebMedia = vi.fn(async () => ({
    buffer: IMAGE,
    contentType: "image/png",
    kind: "image" as const,
    fileName: "fixture.png",
  }));
  const describeImage = vi.fn(async (_req: ImageDescriptionRequest) => ({ text: "local result" }));
  const provider: MediaUnderstandingProvider = {
    id: "llama-cpp",
    capabilities: ["image"],
    describeImage,
  };
  const factories: OpenClawPluginToolFactory[] = [];
  const api = createTestPluginApi({
    config: cfg,
    runtime: createPluginRuntimeMock({ media: { loadWebMedia } }),
    registerTool: (tool) => {
      if (typeof tool === "function") {
        factories.push(tool);
      }
    },
  });
  registerLlamaCppMediaTool(api, provider);
  const factory = factories[0];
  if (!factory) {
    throw new Error("local_image factory was not registered");
  }
  const tool = factory({
    agentDir: "/agent",
    workspaceDir: "/workspace",
    fsPolicy: { workspaceOnly: true },
    ...ctx,
  });
  if (Array.isArray(tool)) {
    throw new Error("local_image must register one tool");
  }
  return { api, tool, describeImage, loadWebMedia };
}

function requireTool(fixture: ReturnType<typeof capture>) {
  if (!fixture.tool) {
    throw new Error("Expected the configured local_image tool");
  }
  return fixture.tool;
}

describe("registered local_image tool", () => {
  it("declares the registered tool for manifest-driven lazy discovery", () => {
    expect(manifest.contracts.tools).toContain(requireTool(capture()).name);
  });

  it.each([
    { task: "ocr", prompt: "Transcribe the receipt.", model: "local-ocr" },
    { task: "vision", prompt: "Which shape is above the circle?", model: "local-vision" },
    { task: undefined, prompt: "Read the text", model: "local-vision" },
  ])(
    "routes task $task by explicit intent, independent of prompt words",
    async ({ task, prompt, model }) => {
      const fixture = capture();
      const controller = new AbortController();
      const result = await requireTool(fixture).execute(
        "test",
        { path: "fixture.png", task, prompt },
        controller.signal,
      );
      expect(fixture.describeImage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          buffer: IMAGE,
          model,
          prompt,
          signal: controller.signal,
          maxTokens: LLAMA_CPP_MEDIA_MAX_TOKENS,
          timeoutMs: LLAMA_CPP_MEDIA_TIMEOUT_MS,
        }),
      );
      expect(fixture.loadWebMedia).toHaveBeenCalledWith(path.resolve("/workspace/fixture.png"), {
        maxBytes: LLAMA_CPP_MEDIA_MAX_BYTES,
        localRoots: [path.resolve("/workspace")],
        requestInit: { signal: controller.signal },
      });
      expect(result.content).toEqual([{ type: "text", text: "local result" }]);
      expect(IMAGE).toEqual(fixture.describeImage.mock.calls[0]?.[0].buffer);
    },
  );

  it.each([
    { task: "guess", path: "fixture.png" },
    { task: null, path: "fixture.png" },
    { path: "https://example.test/private.png" },
    { path: "data:image/png;base64,aaaa" },
    { path: "" },
    { path: "fixture.png", prompt: 7 },
    { path: "fixture.png", prompt: "x".repeat(8193) },
  ])("rejects invalid input without loading or inference: $path", async (input) => {
    const fixture = capture();
    await expect(requireTool(fixture).execute("test", input)).rejects.toThrow();
    expect(fixture.loadWebMedia).not.toHaveBeenCalled();
    expect(fixture.describeImage).not.toHaveBeenCalled();
  });

  it("fails before reading an image when a selected model is missing", async () => {
    const cfg = configured();
    const configuredProvider = cfg.models?.providers?.["llama-cpp"];
    if (!configuredProvider) {
      throw new Error("fixture provider missing");
    }
    configuredProvider.models = configuredProvider.models.filter(
      (model) => model.id !== "local-ocr",
    );
    const fixture = capture({}, cfg);
    await expect(
      requireTool(fixture).execute("test", { path: "fixture.png", task: "ocr" }),
    ).rejects.toThrow("unavailable");
    expect(fixture.loadWebMedia).not.toHaveBeenCalled();
    expect(fixture.describeImage).not.toHaveBeenCalled();
  });

  it.each([
    "https://cloud.example.test/v1",
    "http://127.0.0.1:19433/v1",
    "http://127.0.0.1:19432/other",
  ])("rejects a selected model endpoint override before loading input: %s", async (baseUrl) => {
    const cfg = configured();
    const model = cfg.models?.providers?.["llama-cpp"]?.models.find(
      (entry) => entry.id === "local-vision",
    );
    if (!model) {
      throw new Error("fixture model missing");
    }
    model.baseUrl = baseUrl;
    const fixture = capture({}, cfg);
    await expect(requireTool(fixture).execute("test", { path: "fixture.png" })).rejects.toThrow(
      "endpoint must match",
    );
    expect(fixture.loadWebMedia).not.toHaveBeenCalled();
    expect(fixture.describeImage).not.toHaveBeenCalled();
  });

  it("accepts a selected model endpoint matching the managed provider", async () => {
    const cfg = configured();
    const provider = cfg.models?.providers?.["llama-cpp"];
    const model = provider?.models.find((entry) => entry.id === "local-vision");
    if (!provider || !model) {
      throw new Error("fixture model missing");
    }
    model.baseUrl = provider.baseUrl;
    const fixture = capture({}, cfg);
    await requireTool(fixture).execute("test", { path: "fixture.png" });
    expect(fixture.describeImage).toHaveBeenCalledOnce();
  });

  it("does not expose the host tool to sandboxed or unconfigured agents", () => {
    expect(capture({ sandboxed: true }).tool).toBeNull();
    expect(capture({}, {}).tool).toBeNull();
    const cfg = configured();
    const provider = cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    delete provider.localService;
    expect(capture({}, cfg).tool).toBeNull();
    provider.localService = { command: "/runtime/llama-server" };
    provider.baseUrl = "https://cloud.example.test/v1";
    expect(capture({}, cfg).tool).toBeNull();
  });

  it("rechecks changed provider ownership before reading input", async () => {
    let cfg = configured();
    const fixture = capture({ getRuntimeConfig: () => cfg });
    cfg = {};
    await expect(requireTool(fixture).execute("test", { path: "fixture.png" })).rejects.toThrow(
      "setup",
    );
    expect(fixture.loadWebMedia).not.toHaveBeenCalled();
  });

  it("blocks an explicit proxy at registration and after runtime configuration changes", async () => {
    const cfg = configured();
    const provider = cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    const fixture = capture({ getRuntimeConfig: () => cfg }, cfg);
    provider.request = {
      proxy: { mode: "explicit-proxy", url: "http://proxy.example.test:8080" },
    };
    const previous = structuredClone(cfg);
    expect(capture({}, cfg).tool).toBeNull();
    await expect(requireTool(fixture).execute("test", { path: "fixture.png" })).rejects.toThrow(
      "without an explicit llama.cpp request proxy",
    );
    expect(cfg).toEqual(previous);
    expect(fixture.loadWebMedia).not.toHaveBeenCalled();
    expect(fixture.describeImage).not.toHaveBeenCalled();
  });

  it("propagates local failure without trying configured cloud fallbacks", async () => {
    const cfg = configured();
    cfg.agents = {
      defaults: { imageModel: { primary: "llama-cpp/local-vision", fallbacks: ["openai/vision"] } },
    };
    const fixture = capture({}, cfg);
    fixture.describeImage.mockRejectedValueOnce(new Error("projector missing; rerun setup"));
    await expect(
      requireTool(fixture).execute("test", { path: "fixture.png", task: "ocr" }),
    ).rejects.toThrow("projector missing");
    expect(fixture.describeImage).toHaveBeenCalledTimes(1);
    expect(fixture.describeImage.mock.calls[0]?.[0].provider).toBe("llama-cpp");
    fixture.describeImage.mockResolvedValueOnce({ text: " " });
    await expect(requireTool(fixture).execute("test", { path: "fixture.png" })).rejects.toThrow(
      "returned no text",
    );
  });

  it("honors configured lower image and response budgets", async () => {
    const cfg = configured();
    cfg.tools = { media: { image: { maxBytes: 1024, maxChars: 5, timeoutSeconds: 7 } } };
    const fixture = capture({}, cfg);
    const result = await requireTool(fixture).execute("test", { path: "fixture.png" });
    expect(fixture.loadWebMedia).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxBytes: 1024 }),
    );
    expect(fixture.describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 7000 }),
    );
    expect(result.content).toEqual([{ type: "text", text: "local" }]);
  });

  it("cancels before input, after input, and during the registered provider inference", async () => {
    const fixture = capture();
    const tool = requireTool(fixture);
    const before = new AbortController();
    before.abort();
    await expect(tool.execute("test", { path: "fixture.png" }, before.signal)).rejects.toThrow();
    expect(fixture.loadWebMedia).not.toHaveBeenCalled();
    const after = new AbortController();
    fixture.loadWebMedia.mockImplementationOnce(async () => {
      after.abort();
      return { buffer: IMAGE, contentType: "image/png", kind: "image", fileName: "fixture.png" };
    });
    await expect(tool.execute("test", { path: "fixture.png" }, after.signal)).rejects.toThrow();
    expect(fixture.describeImage).not.toHaveBeenCalled();
    const during = new AbortController();
    fixture.describeImage.mockImplementationOnce(async (req) => {
      expect(req.signal).toBe(during.signal);
      during.abort();
      req.signal?.throwIfAborted();
      return { text: "unreachable" };
    });
    await expect(tool.execute("test", { path: "fixture.png" }, during.signal)).rejects.toThrow();
  });

  it("uses shared safe loading and preserves the original file", async () => {
    const { loadWebMedia } = await import("openclaw/plugin-sdk/web-media");
    const root = tempDirs.make("llama-media-tool-");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const source = path.join(workspace, "fixture.png");
    await fs.writeFile(source, IMAGE);
    const fixture = capture({ workspaceDir: workspace });
    fixture.api.runtime.media.loadWebMedia = loadWebMedia;
    const tool = requireTool(fixture);
    await tool.execute("test", { path: "fixture.png" });
    expect(await fs.readFile(source)).toEqual(IMAGE);
    expect(fixture.describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ mime: "image/png" }),
    );
    const outside = path.join(root, "private.png");
    await fs.writeFile(outside, IMAGE);
    await expect(tool.execute("test", { path: "../private.png" })).rejects.toThrow();
    if (process.platform !== "win32") {
      await fs.symlink(outside, path.join(workspace, "escape.png"));
      await expect(tool.execute("test", { path: "escape.png" })).rejects.toThrow();
    }
    expect(fixture.describeImage).toHaveBeenCalledTimes(1);
    await fs.writeFile(path.join(workspace, "not-image.txt"), "not an image");
    await expect(tool.execute("test", { path: "not-image.txt" })).rejects.toThrow(
      "must be an image",
    );
    const noWorkspace = capture({ workspaceDir: undefined });
    noWorkspace.api.runtime.media.loadWebMedia = loadWebMedia;
    await expect(requireTool(noWorkspace).execute("test", { path: source })).rejects.toThrow();
    expect(noWorkspace.describeImage).not.toHaveBeenCalled();
    const smallConfig = configured();
    smallConfig.tools = { media: { image: { maxBytes: 1 } } };
    const oversized = capture({ workspaceDir: workspace }, smallConfig);
    oversized.api.runtime.media.loadWebMedia = loadWebMedia;
    await expect(requireTool(oversized).execute("test", { path: "fixture.png" })).rejects.toThrow();
    expect(oversized.describeImage).not.toHaveBeenCalled();
  });
});
