import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ImageDescriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { encodePngRgba } from "openclaw/plugin-sdk/test-media-generation";
import { loadWebMedia as loadRealMedia } from "openclaw/plugin-sdk/web-media";
import { afterEach, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  LLAMA_CPP_MEDIA_MAX_BYTES,
  LLAMA_CPP_MEDIA_MAX_TOKENS,
  LLAMA_CPP_MEDIA_TIMEOUT_MS,
} from "./media-config.js";
import { registerLlamaCppMediaTool } from "./media-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const IMAGE = encodePngRgba(Buffer.from([255, 0, 0, 255]), 1, 1);

afterEach(() => vi.unstubAllEnvs());

type Provider = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

function configured(overrides: OpenClawConfig = {}) {
  const provider: Provider = {
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
  };
  const cfg: OpenClawConfig = { ...overrides, models: { providers: { "llama-cpp": provider } } };
  return { cfg, provider };
}

function capture(
  { realMedia = false, ...ctx }: OpenClawPluginToolContext & { realMedia?: boolean } = {},
  cfg = configured().cfg,
) {
  const loadWebMedia = vi.fn(async () => ({
    buffer: IMAGE,
    contentType: "image/png",
    kind: "image" as const,
    fileName: "fixture.png",
  }));
  const describeImage = vi.fn(async (_req: ImageDescriptionRequest) => ({ text: "local result" }));
  const registerTool = vi.fn<ReturnType<typeof createTestPluginApi>["registerTool"]>();
  const api = createTestPluginApi({
    config: cfg,
    runtime: createPluginRuntimeMock({
      media: { loadWebMedia: realMedia ? loadRealMedia : loadWebMedia },
    }),
    registerTool,
  });
  registerLlamaCppMediaTool(api, { id: "llama-cpp", capabilities: ["image"], describeImage });
  const factory = registerTool.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("local_image factory was not registered");
  }
  const registered = factory({
    agentDir: "/agent",
    workspaceDir: "/workspace",
    fsPolicy: { workspaceOnly: true },
    ...ctx,
  });
  if (Array.isArray(registered)) {
    throw new Error("local_image must register one tool");
  }
  const tool = registered;
  async function run(input: unknown = "fixture.png", signal?: AbortSignal) {
    if (!tool) {
      throw new Error("Expected the configured local_image tool");
    }
    return await tool.execute("test", typeof input === "string" ? { path: input } : input, signal);
  }
  async function blocked(input?: unknown, message?: string) {
    await expect(run(input)).rejects.toThrow(message);
    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(describeImage).not.toHaveBeenCalled();
  }
  return { tool, run, blocked, describeImage, loadWebMedia };
}

it("declares the registered tool for manifest-driven lazy discovery", () => {
  expect(manifest.contracts.tools).toContain(capture().tool?.name);
});

it.each([
  [{ task: "vision", prompt: "Which shape is above the circle?" }, undefined, "local result"],
  [
    { task: undefined, prompt: undefined },
    { maxBytes: 1024, maxChars: 5, timeoutSeconds: 7 },
    "local",
  ],
] as const)("routes local vision with intent/budget %j", async (input, budget, text) => {
  const model = "local-vision";
  const fixture = capture(
    {},
    configured(budget ? { tools: { media: { image: budget } } } : {}).cfg,
  );
  const controller = new AbortController();
  const result = await fixture.run({ path: "fixture.png", ...input }, controller.signal);
  expect(fixture.describeImage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      buffer: IMAGE,
      model,
      prompt: input.prompt ?? "Describe the image.",
      signal: controller.signal,
      maxTokens: LLAMA_CPP_MEDIA_MAX_TOKENS,
      timeoutMs: budget ? budget.timeoutSeconds * 1000 : LLAMA_CPP_MEDIA_TIMEOUT_MS,
    }),
  );
  expect(fixture.loadWebMedia).toHaveBeenCalledWith(path.resolve("/workspace/fixture.png"), {
    maxBytes: budget?.maxBytes ?? LLAMA_CPP_MEDIA_MAX_BYTES,
    localRoots: [path.resolve("/workspace")],
    requestInit: { signal: controller.signal },
  });
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(result.details).toMatchObject({ text, task: "vision", model });
});

it.each([
  { task: null, path: "fixture.png" },
  { path: "https://example.test/private.png" },
  { path: "" },
  { path: "fixture.png", prompt: "x".repeat(8193) },
])("rejects invalid input without loading or inference: $path", async (input) => {
  await capture().blocked(input);
});

it.each([
  ["ocr", undefined, "unavailable"],
  ["vision", "https://cloud.example.test/v1", "endpoint must match"],
] as const)(
  "rejects unavailable or redirected %s before reading input",
  async (task, baseUrl, error) => {
    const { cfg, provider } = configured();
    provider.models = provider.models.flatMap((model) =>
      model.id !== `local-${task}` ? [model] : baseUrl ? [{ ...model, baseUrl }] : [],
    );
    await capture({}, cfg).blocked({ path: "fixture.png", task }, error);
  },
);

it("does not expose the host tool to sandboxed or unconfigured agents", () => {
  expect(capture({ sandboxed: true }).tool).toBeNull();
  expect(capture({}, {}).tool).toBeNull();
  const { cfg, provider } = configured();
  delete provider.localService;
  expect(capture({}, cfg).tool).toBeNull();
  provider.localService = { command: "/runtime/llama-server" };
  provider.baseUrl = "https://cloud.example.test/v1";
  expect(capture({}, cfg).tool).toBeNull();
});

it("rechecks changed provider ownership before reading input", async () => {
  let { cfg } = configured();
  const fixture = capture({ getRuntimeConfig: () => cfg });
  cfg = {};
  await expect(fixture.run()).rejects.toThrow("setup");
  expect(fixture.loadWebMedia).not.toHaveBeenCalled();
});

it("blocks an explicit proxy at registration and after runtime configuration changes", async () => {
  const { cfg, provider } = configured();
  const fixture = capture({ getRuntimeConfig: () => cfg }, cfg);
  provider.request = {
    proxy: { mode: "explicit-proxy", url: "http://proxy.example.test:8080" },
  };
  const previous = structuredClone(cfg);
  expect(capture({}, cfg).tool).toBeNull();
  await fixture.blocked(undefined, "without an explicit llama.cpp request proxy");
  expect(cfg).toEqual(previous);
});

it("propagates local failure without trying configured cloud fallbacks", async () => {
  const { cfg } = configured({
    agents: {
      defaults: { imageModel: { primary: "llama-cpp/local-vision", fallbacks: ["openai/vision"] } },
    },
  });
  const fixture = capture({}, cfg);
  fixture.describeImage.mockRejectedValueOnce(new Error("projector missing; rerun setup"));
  await expect(fixture.run({ path: "fixture.png", task: "ocr" })).rejects.toThrow(
    "projector missing",
  );
  expect(fixture.describeImage).toHaveBeenCalledTimes(1);
  expect(fixture.describeImage.mock.calls[0]?.[0].provider).toBe("llama-cpp");
  fixture.describeImage.mockResolvedValueOnce({ text: " " });
  await expect(fixture.run()).rejects.toThrow("returned no text");
});

it("cancels before input, after input, and during the registered provider inference", async () => {
  const fixture = capture();
  const before = new AbortController();
  before.abort();
  await expect(fixture.run(undefined, before.signal)).rejects.toThrow();
  expect(fixture.loadWebMedia).not.toHaveBeenCalled();
  const after = new AbortController();
  fixture.loadWebMedia.mockImplementationOnce(async () => {
    after.abort();
    return { buffer: IMAGE, contentType: "image/png", kind: "image", fileName: "fixture.png" };
  });
  await expect(fixture.run(undefined, after.signal)).rejects.toThrow();
  expect(fixture.describeImage).not.toHaveBeenCalled();
  const during = new AbortController();
  fixture.describeImage.mockImplementationOnce(async (req) => {
    expect(req.signal).toBe(during.signal);
    during.abort();
    req.signal?.throwIfAborted();
    return { text: "unreachable" };
  });
  await expect(fixture.run(undefined, during.signal)).rejects.toThrow();
});

it("uses shared safe loading and preserves the original file", async () => {
  const root = tempDirs.make("llama-media-tool-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const source = path.join(workspace, "fixture.png");
  await fs.writeFile(source, IMAGE);
  const fixture = capture({ workspaceDir: workspace, realMedia: true });
  await fixture.run();
  expect(await fs.readFile(source)).toEqual(IMAGE);
  expect(fixture.describeImage.mock.calls[0]?.[0]).toMatchObject({ mime: "image/png" });
  const outside = path.join(root, "private.png");
  await fs.writeFile(outside, IMAGE);
  await expect(fixture.run("../private.png")).rejects.toThrow();
  if (process.platform !== "win32") {
    await fs.symlink(outside, path.join(workspace, "escape.png"));
    await expect(fixture.run("escape.png")).rejects.toThrow();
  }
  expect(fixture.describeImage).toHaveBeenCalledTimes(1);
  await fs.writeFile(path.join(workspace, "not-image.txt"), "not an image");
  await expect(fixture.run("not-image.txt")).rejects.toThrow("must be an image");
  const noWorkspace = capture({ workspaceDir: undefined, realMedia: true });
  await expect(noWorkspace.run(source)).rejects.toThrow();
  expect(noWorkspace.describeImage).not.toHaveBeenCalled();
  const oversized = capture(
    { workspaceDir: workspace, realMedia: true },
    configured({ tools: { media: { image: { maxBytes: 1 } } } }).cfg,
  );
  await expect(oversized.run()).rejects.toThrow();
  expect(oversized.describeImage).not.toHaveBeenCalled();
});

it("reads inbound media and host-approved read-only paths under workspace-only policy", async () => {
  const root = tempDirs.make("llama-media-tool-roots-");
  const workspace = path.join(root, "workspace");
  const inbound = path.join(root, "media", "inbound");
  const approved = path.join(root, "approved");
  for (const directory of [workspace, inbound, approved]) {
    await fs.mkdir(directory, { recursive: true });
  }
  await fs.writeFile(path.join(inbound, "fixture.png"), IMAGE);
  const approvedFile = path.join(approved, "fixture.png");
  await fs.writeFile(approvedFile, IMAGE);
  const outside = path.join(root, "private.png");
  await fs.writeFile(outside, IMAGE);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  const fixture = capture({
    realMedia: true,
    workspaceDir: workspace,
    fsPolicy: { workspaceOnly: true, readOnlyRoots: [approved] },
  });
  for (const source of ["media://inbound/fixture.png", approvedFile, "~/approved/fixture.png"]) {
    await expect.soft(fixture.run(source)).resolves.toMatchObject({
      content: [{ type: "text", text: "local result" }],
    });
  }
  await expect(fixture.run(outside)).rejects.toThrow();
});
