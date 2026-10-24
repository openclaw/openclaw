import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  describeImageWithModel,
  describeImagesWithModel,
  describeImagesWithModelPayloadTransform,
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
} from "openclaw/plugin-sdk/media-understanding";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LLAMA_CPP_MEDIA_RECIPES } from "./media-catalog.js";
import { LLAMA_CPP_MEDIA_MAX_BYTES, LLAMA_CPP_MEDIA_MAX_TOKENS } from "./media-config.js";

const transport = vi.hoisted(() => ({
  single: vi.fn<typeof describeImageWithModel>(),
  multiple: vi.fn<typeof describeImagesWithModel>(),
  managed: vi.fn<typeof describeImagesWithModelPayloadTransform>(),
}));

vi.mock("openclaw/plugin-sdk/media-understanding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding")>()),
  describeImageWithModel: transport.single,
  describeImagesWithModel: transport.multiple,
  describeImagesWithModelPayloadTransform: transport.managed,
}));

import { createLlamaCppMediaProvider } from "./media-provider.js";

const OCR = "glm-ocr-q8_0";
const VISION = "smolvlm2-2.2b-instruct-q4_k_m";
const IMAGE = Buffer.from("synthetic-image-bytes");
const ARTIFACT_ERROR = "must match the verified recipe artifacts. Rerun local media setup";
const EXPLICIT_PROXY = { proxy: { mode: "explicit-proxy", url: "http://proxy.example.test:8080" } };
const REQUEST_MODEL = {
  id: VISION,
  name: "test vision model",
  provider: "llama-cpp",
  api: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:19432/v1",
  reasoning: false,
  input: ["image" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: LLAMA_CPP_MEDIA_MAX_TOKENS,
};

function request(overrides: Partial<ImagesDescriptionRequest> = {}): ImagesDescriptionRequest {
  return {
    images: [{ buffer: IMAGE, fileName: "synthetic.png", mime: "image/png" }],
    model: VISION,
    provider: "llama-cpp",
    prompt: "Which shape is above the circle?",
    timeoutMs: 10_000,
    agentDir: "/isolated-agent",
    cfg: {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://127.0.0.1:19432/v1",
            localService: { command: "/runtime/llama-server" },
            params: { mediaModels: { ocr: OCR, vision: VISION } },
            models: LLAMA_CPP_MEDIA_RECIPES.map((recipe) => ({
              id: recipe.id,
              name: recipe.name,
              input: ["image"],
              reasoning: false,
              cost: REQUEST_MODEL.cost,
              contextWindow: 8192,
              maxTokens: LLAMA_CPP_MEDIA_MAX_TOKENS,
              params: {
                modelPath: recipe.model.source,
                mmprojPath: recipe.projector.source,
              },
            })),
          },
        },
      },
      agents: {
        defaults: {
          imageModel: { primary: `llama-cpp/${VISION}`, fallbacks: ["openai/vision"] },
        },
      },
    },
    ...overrides,
  };
}

function providerMethods() {
  const { describeImage: single, describeImages: multiple } = createLlamaCppMediaProvider();
  assert(single && multiple, "llama-cpp must register both image provider hooks");
  return { single, multiple };
}

function configured(cfg: OpenClawConfig) {
  const provider = cfg.models?.providers?.["llama-cpp"];
  assert(provider, "fixture provider missing");
  return provider;
}

function visionModel(cfg: OpenClawConfig) {
  const model = configured(cfg).models.find((entry) => entry.id === VISION);
  assert(model, "fixture model missing");
  return model;
}

function singleRequest({ images, ...req }: ImagesDescriptionRequest): ImageDescriptionRequest {
  const image = images[0];
  assert(image, "fixture image missing");
  return { ...req, ...image };
}

function prepare(req: ImagesDescriptionRequest, config = req.cfg) {
  req.preparedModelRuntime = { agentDir: req.agentDir, config, createStores: () => ({}) };
}

function expectNoGenericTransport() {
  expect(transport.single).not.toHaveBeenCalled();
  expect(transport.multiple).not.toHaveBeenCalled();
}

async function expectRejected(req: ImagesDescriptionRequest, message?: string) {
  await expect(providerMethods().multiple(req)).rejects.toThrow(message);
  expect(transport.managed).not.toHaveBeenCalled();
  expectNoGenericTransport();
}

async function transformedPayload(payload: unknown) {
  const call = transport.managed.mock.calls[0];
  assert(call?.[1], "Managed image transport did not register its payload transform");
  return await call[1](payload, { ...REQUEST_MODEL, id: call[0].model });
}

function captureSend(model = REQUEST_MODEL, before: () => void = () => {}) {
  const send = vi.fn();
  transport.managed.mockImplementationOnce(async (_req, transform) => {
    await Promise.resolve();
    before();
    assert(transform, "fixture transform missing");
    await transform({ messages: [{ role: "user", content: [] }] }, model);
    send();
    return { text: "local result" };
  });
  return send;
}

beforeEach(() => {
  vi.resetAllMocks();
  transport.single.mockResolvedValue({ text: "external image" });
  transport.multiple.mockResolvedValue({ text: "external images" });
  transport.managed.mockResolvedValue({ text: "local result" });
});

afterEach(() => vi.unstubAllEnvs());

it("uses the selected OCR recipe task token", async () => {
  const req = request({ model: OCR, prompt: "Describe the colors." });
  const original = structuredClone(req.images);
  await providerMethods().multiple(req);
  expect(transport.managed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ model: OCR, prompt: "Text Recognition:" }),
    expect.any(Function),
  );
  const imagePart = { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } };
  const payload = {
    model: OCR,
    messages: [
      { role: "system", content: "Text Recognition:" },
      { role: "user", content: [imagePart] },
    ],
    max_tokens: 2048,
  };
  expect(await transformedPayload(payload)).toEqual({
    model: OCR,
    messages: [{ role: "user", content: [imagePart, { type: "text", text: "Text Recognition:" }] }],
    max_tokens: 2048,
    temperature: 0,
    seed: 4827,
  });
  expect(payload.messages).toHaveLength(2);
  expect(Buffer.from(original[0]?.buffer ?? [])).toEqual(req.images[0]?.buffer);
  expectNoGenericTransport();
});

it("routes a single image through the same managed images transport with signal and prepared facts", async () => {
  const signal = new AbortController().signal;
  const base = request({ signal, prompt: undefined });
  prepare(base);
  await providerMethods().single(singleRequest(base));
  expect(transport.managed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ ...base, prompt: "Describe the image." }),
    expect.any(Function),
  );
});

it("keeps existing external and custom image models on the shared generic transport", async () => {
  const hooks = providerMethods();
  const req = request({ cfg: {}, model: "external-custom-vision" });
  await hooks.multiple(req);
  expect(transport.multiple).toHaveBeenCalledExactlyOnceWith(req);
  await hooks.single(singleRequest(req));
  expect(transport.single).toHaveBeenCalledExactlyOnceWith(singleRequest(req));
  await hooks.multiple(request({ model: "my-other-image-model" }));
  expect(transport.managed).not.toHaveBeenCalled();
});

it("does not retry with a cloud provider after local inference fails", async () => {
  transport.managed.mockRejectedValueOnce(new Error("projector load failed"));
  await expect(providerMethods().multiple(request())).rejects.toThrow("projector load failed");
  expect(transport.managed).toHaveBeenCalledTimes(1);
  expectNoGenericTransport();
});

it("fails closed for incomplete saved local routes", async () => {
  const req = request();
  const provider = configured(req.cfg);
  provider.params = { mediaModels: { ocr: OCR } };
  provider.baseUrl = "https://cloud.example.test/v1";
  const hooks = providerMethods();
  await expect(hooks.multiple(req)).rejects.toThrow("local media routes are incomplete");
  await expect(hooks.single(singleRequest(req))).rejects.toThrow(
    "local media routes are incomplete",
  );
  expect(transport.managed).not.toHaveBeenCalled();
  expectNoGenericTransport();
});

it.each([
  "https://cloud.example.test/v1",
  "http://127.0.0.1.example.test:19432/v1",
  "not-a-url",
  "http://fixture-user@127.0.0.1:19432/v1",
  "http://:fixture-password@127.0.0.1:19432/v1",
])("rejects an untrusted managed endpoint before transport: %s", async (baseUrl) => {
  const req = request();
  configured(req.cfg).baseUrl = baseUrl;
  await expectRejected(req, "loopback");
});

it("accepts numeric IPv6 loopback endpoints", async () => {
  const req = request();
  configured(req.cfg).baseUrl = "http://[::1]:19432/v1";
  await providerMethods().multiple(req);
  expect(transport.managed).toHaveBeenCalledOnce();
});

it("rejects missing managed ownership and provider identity substitution", async () => {
  const req = request();
  delete configured(req.cfg).localService;
  await expect(providerMethods().multiple(req)).rejects.toThrow("loopback");
  await expect(providerMethods().multiple(request({ provider: "openai" }))).rejects.toThrow(
    "loopback",
  );
  expect(transport.managed).not.toHaveBeenCalled();
});

it.each([
  [false, "model", "input", ["text"], "model is unavailable"],
  ["shared", "model", "baseUrl", "https://cloud.example.test/v1", "endpoint must match"],
  [false, "params", "modelPath", "hf:unknown/model/model.gguf", ARTIFACT_ERROR],
  [false, "params", "mmprojPath", "hf:unknown/projector/mmproj.gguf", ARTIFACT_ERROR],
  [true, "provider", "request", EXPLICIT_PROXY, "direct loopback"],
  [true, "params", "modelPath", "hf:custom/model/other.gguf", "verified recipe artifacts"],
  [true, "params", "mmprojPath", "hf:custom/model/other.gguf", "verified recipe artifacts"],
  [true, "provider", "baseUrl", "http://127.0.0.1:19433/v1", "endpoint must match"],
] as const)("rejects retained=%s %s.%s=%j", async (retained, target, field, value, error) => {
  const req = request();
  const config = retained === true ? structuredClone(req.cfg) : req.cfg;
  const model = visionModel(config);
  const destination =
    target === "provider" ? configured(config) : target === "model" ? model : model.params;
  assert(destination, "fixture model artifacts missing");
  Object.assign(destination, { [field]: value });
  if (retained) {
    prepare(req, config);
  }
  await expectRejected(req, error);
});

it.each([{ provider: "openai" }, { id: OCR }, { baseUrl: "https://cloud.example.test/v1" }])(
  "blocks a prepared runtime's changed final transport target: %j",
  async (override) => {
    const req = request();
    prepare(req);
    const send = captureSend({ ...REQUEST_MODEL, ...override });
    await expect(providerMethods().multiple(req)).rejects.toThrow(
      "resolved local image model must match",
    );
    expect(send).not.toHaveBeenCalled();
    expectNoGenericTransport();
  },
);

it("rejects environment proxy routing without an explicit provider proxy", async () => {
  vi.stubEnv("http_proxy", "http://proxy.example.test:8080");
  vi.stubEnv("no_proxy", "");
  const req = request();
  const original = {
    ...structuredClone(req),
    images: req.images.map((image) => ({ ...image, buffer: Buffer.from(image.buffer) })),
  };
  await expectRejected(req, "NO_PROXY");
  expect(req).toEqual(original);
  expect(req.images[0]?.buffer).toBe(IMAGE);
  vi.stubEnv("no_proxy", "127.0.0.1");
  await expect(providerMethods().multiple(req)).resolves.toEqual({ text: "local result" });
});

it("rechecks an environment proxy enabled during model preparation", async () => {
  const send = captureSend(REQUEST_MODEL, () => {
    vi.stubEnv("http_proxy", "http://proxy.example.test:8080");
    vi.stubEnv("no_proxy", "");
  });
  const result = providerMethods().multiple(request());
  await expect(result).rejects.toThrow("NO_PROXY");
  expect(send).not.toHaveBeenCalled();
  expectNoGenericTransport();
});

it.each([
  [{ buffer: Buffer.alloc(LLAMA_CPP_MEDIA_MAX_BYTES + 1), fileName: "large.png" }],
  [
    { buffer: IMAGE, fileName: "one.png" },
    { buffer: IMAGE, fileName: "two.png" },
  ],
])("rejects empty, oversized, or multiple image input before transport", async (...images) => {
  await expectRejected(request({ images }));
});

it("rejects a zero output token budget", async () => {
  await expectRejected(request({ maxTokens: 0 }), "positive finite");
});

it("carries cancellation to shared inference and refuses results after cancellation", async () => {
  const hooks = providerMethods();
  const before = new AbortController();
  before.abort();
  await expectRejected(request({ signal: before.signal }));
  const during = new AbortController();
  transport.managed.mockImplementationOnce(async (req) => {
    expect(req.signal).toBe(during.signal);
    during.abort();
    return { text: "late result" };
  });
  await expect(hooks.multiple(request({ signal: during.signal }))).rejects.toThrow();
  expect(transport.multiple).not.toHaveBeenCalled();
});

it("rejects incompatible payload format and unavailable recipe with useful setup errors", async () => {
  const req = request();
  await providerMethods().multiple(req);
  await expect(
    transformedPayload({ messages: [{ role: "user", content: "plain text" }] }),
  ).rejects.toThrow("OpenAI image request format");
  const provider = configured(req.cfg);
  provider.params = { mediaModels: { ocr: OCR, vision: "missing-recipe" } };
  provider.models.push({ ...provider.models[0]!, id: "missing-recipe" });
  await expect(providerMethods().multiple({ ...req, model: "missing-recipe" })).rejects.toThrow(
    "recipe is unavailable",
  );
  expect(transport.managed).toHaveBeenCalledTimes(1);
});
