import type {
  describeImageWithModel,
  describeImagesWithModel,
  describeImagesWithModelPayloadTransform,
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
} from "openclaw/plugin-sdk/media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_CPP_MEDIA_RECIPES } from "./media-catalog.js";
import {
  LLAMA_CPP_MEDIA_MAX_BYTES,
  LLAMA_CPP_MEDIA_MAX_CHARS,
  LLAMA_CPP_MEDIA_MAX_TOKENS,
} from "./media-config.js";

const transport = vi.hoisted(() => ({
  single: vi.fn<typeof describeImageWithModel>(),
  multiple: vi.fn<typeof describeImagesWithModel>(),
  managed: vi.fn<typeof describeImagesWithModelPayloadTransform>(),
}));

vi.mock("openclaw/plugin-sdk/media-understanding", () => ({
  describeImageWithModel: transport.single,
  describeImagesWithModel: transport.multiple,
  describeImagesWithModelPayloadTransform: transport.managed,
}));

import { createLlamaCppMediaProvider } from "./media-provider.js";

const OCR = "glm-ocr-q8_0";
const VISION = "smolvlm2-2.2b-instruct-q4_k_m";
const IMAGE = Buffer.from("synthetic-image-bytes");
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
  const provider = createLlamaCppMediaProvider();
  if (!provider.describeImage || !provider.describeImages) {
    throw new Error("llama-cpp must register both image provider hooks");
  }
  return { single: provider.describeImage, multiple: provider.describeImages };
}

async function transformedPayload(payload: unknown) {
  const call = transport.managed.mock.calls[0];
  if (!call?.[1]) {
    throw new Error("Managed image transport did not register its payload transform");
  }
  return await call[1](payload, { ...REQUEST_MODEL, id: call[0].model });
}

beforeEach(() => {
  vi.resetAllMocks();
  transport.single.mockResolvedValue({ text: "external image" });
  transport.multiple.mockResolvedValue({ text: "external images" });
  transport.managed.mockResolvedValue({ text: "local result" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("llama-cpp registered media provider", () => {
  it.each(["Describe the colors.", "Read the screenshot text."])(
    "uses the OCR recipe task token for the selected OCR model: %s",
    async (prompt) => {
      const req = request({ model: OCR, prompt });
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
        messages: [
          { role: "user", content: [imagePart, { type: "text", text: "Text Recognition:" }] },
        ],
        max_tokens: 2048,
        temperature: 0,
        seed: 4827,
      });
      expect(payload.messages).toHaveLength(2);
      expect(Buffer.from(original[0]?.buffer ?? [])).toEqual(req.images[0]?.buffer);
      expect(transport.single).not.toHaveBeenCalled();
      expect(transport.multiple).not.toHaveBeenCalled();
    },
  );

  it.each([
    "Which shape is above the circle?",
    "Read the text in this diagram, and explain the arrows.",
  ])(
    "preserves a vision question without treating its words as an OCR signal: %s",
    async (prompt) => {
      await providerMethods().multiple(request({ prompt }));
      expect(transport.managed).toHaveBeenCalledWith(
        expect.objectContaining({ model: VISION, prompt }),
        expect.any(Function),
      );
      expect(await transformedPayload({ messages: [{ role: "user", content: [] }] })).toEqual({
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        temperature: 0,
        seed: 4827,
      });
    },
  );

  it("routes a single image through the same managed images transport with signal and prepared facts", async () => {
    const signal = new AbortController().signal;
    const base = request({ signal, prompt: undefined });
    base.preparedModelRuntime = {
      agentDir: base.agentDir,
      config: base.cfg,
      createStores: () => ({}),
    };
    const { images, ...req } = base;
    const image = images[0];
    if (!image) {
      throw new Error("fixture image missing");
    }
    const single: ImageDescriptionRequest = { ...req, ...image };
    await providerMethods().single(single);
    expect(transport.managed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        images: [image],
        signal,
        cfg: req.cfg,
        preparedModelRuntime: req.preparedModelRuntime,
        prompt: "Describe the image.",
      }),
      expect.any(Function),
    );
  });

  it("keeps existing external and custom image models on the shared generic transport", async () => {
    const hooks = providerMethods();
    const req = request({ cfg: {}, model: "external-custom-vision" });
    await hooks.multiple(req);
    expect(transport.multiple).toHaveBeenCalledExactlyOnceWith(req);
    const { images, ...single } = req;
    const image = images[0];
    if (!image) {
      throw new Error("fixture image missing");
    }
    await hooks.single({ ...single, ...image });
    expect(transport.single).toHaveBeenCalledExactlyOnceWith({ ...single, ...image });
    await hooks.multiple(request({ model: "my-other-image-model" }));
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it("does not retry with a cloud provider after local inference fails", async () => {
    transport.managed.mockRejectedValueOnce(new Error("projector load failed"));
    await expect(providerMethods().multiple(request())).rejects.toThrow("projector load failed");
    expect(transport.managed).toHaveBeenCalledTimes(1);
    expect(transport.single).not.toHaveBeenCalled();
    expect(transport.multiple).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ocr: OCR }, { ocr: OCR, vision: "" }])(
    "fails closed for incomplete saved local routes: %j",
    async (mediaModels) => {
      const req = request();
      const configured = req.cfg.models?.providers?.["llama-cpp"];
      const image = req.images[0];
      if (!configured || !image) {
        throw new Error("fixture provider or image missing");
      }
      configured.params = { mediaModels };
      configured.baseUrl = "https://cloud.example.test/v1";
      const hooks = providerMethods();
      await expect(hooks.multiple(req)).rejects.toThrow("local media routes are incomplete");
      const { images: _images, ...single } = req;
      await expect(hooks.single({ ...single, ...image })).rejects.toThrow(
        "local media routes are incomplete",
      );
      expect(transport.managed).not.toHaveBeenCalled();
      expect(transport.single).not.toHaveBeenCalled();
      expect(transport.multiple).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://cloud.example.test/v1",
    "http://localhost:19432/v1",
    "http://127.0.0.1.example.test:19432/v1",
    "not-a-url",
  ])("rejects an untrusted managed endpoint before transport: %s", async (baseUrl) => {
    const req = request();
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    provider.baseUrl = baseUrl;
    await expect(providerMethods().multiple(req)).rejects.toThrow("loopback");
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each([
    { username: "fixture-user", password: "" },
    { username: "", password: "fixture-password" },
    { username: "fixture-user", password: "fixture-password" },
  ])("rejects synthetic URL credentials before transport: %j", async (credentials) => {
    const endpoint = new URL("http://127.0.0.1:19432/v1");
    endpoint.username = credentials.username;
    endpoint.password = credentials.password;
    const req = request();
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    provider.baseUrl = endpoint.href;
    await expect(providerMethods().multiple(req)).rejects.toThrow("loopback");
    expect(transport.managed).not.toHaveBeenCalled();
    expect(transport.single).not.toHaveBeenCalled();
    expect(transport.multiple).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1/v1", "http://127.0.0.1:19432/v1", "http://[::1]:19432/v1"])(
    "accepts numeric loopback managed endpoints: %s",
    async (baseUrl) => {
      const req = request();
      const provider = req.cfg.models?.providers?.["llama-cpp"];
      if (!provider) {
        throw new Error("fixture provider missing");
      }
      provider.baseUrl = baseUrl;
      await providerMethods().multiple(req);
      expect(transport.managed).toHaveBeenCalledOnce();
    },
  );

  it("rejects missing managed ownership and provider identity substitution", async () => {
    const req = request();
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    delete provider.localService;
    await expect(providerMethods().multiple(req)).rejects.toThrow("loopback");
    await expect(providerMethods().multiple(request({ provider: "openai" }))).rejects.toThrow(
      "loopback",
    );
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each(["missing", "text-only"])("rejects %s configured image inventory", async (kind) => {
    const req = request();
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    const model = provider?.models.find((entry) => entry.id === VISION);
    if (!provider || !model) {
      throw new Error("fixture model missing");
    }
    if (kind === "missing") {
      provider.models = [];
    } else {
      model.input = ["text"];
    }
    await expect(providerMethods().multiple(req)).rejects.toThrow("model is unavailable");
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each([
    "https://cloud.example.test/v1",
    "http://127.0.0.1:19433/v1",
    "http://127.0.0.1:19432/other",
  ])("rejects a configured model endpoint override: %s", async (baseUrl) => {
    const req = request();
    const model = req.cfg.models?.providers?.["llama-cpp"]?.models.find(
      (entry) => entry.id === VISION,
    );
    if (!model) {
      throw new Error("fixture model missing");
    }
    model.baseUrl = baseUrl;
    req.preparedModelRuntime = {
      agentDir: req.agentDir,
      config: req.cfg,
      createStores: () => ({}),
    };
    await expect(providerMethods().multiple(req)).rejects.toThrow("endpoint must match");
    expect(transport.managed).not.toHaveBeenCalled();
    expect(transport.multiple).not.toHaveBeenCalled();
  });

  it("accepts a configured model endpoint matching the managed provider", async () => {
    const req = request();
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    const model = provider?.models.find((entry) => entry.id === VISION);
    if (!provider || !model) {
      throw new Error("fixture model missing");
    }
    model.baseUrl = provider.baseUrl;
    await providerMethods().multiple(req);
    expect(transport.managed).toHaveBeenCalledOnce();
  });

  it.each([
    { field: "modelPath", source: "hf:unknown/model/model.gguf" },
    { field: "modelPath", source: "/unverified/model.gguf" },
    { field: "modelPath", source: undefined },
    { field: "mmprojPath", source: "hf:unknown/projector/mmproj.gguf" },
    { field: "mmprojPath", source: "/unverified/mmproj.gguf" },
    { field: "mmprojPath", source: undefined },
  ])("rejects a changed or missing curated artifact: $field $source", async ({ field, source }) => {
    const req = request();
    const model = req.cfg.models?.providers?.["llama-cpp"]?.models.find(
      (entry) => entry.id === VISION,
    );
    if (!model?.params) {
      throw new Error("fixture model artifacts missing");
    }
    model.params[field] = source;
    await expect(providerMethods().multiple(req)).rejects.toThrow(
      "must match the verified recipe artifacts. Rerun local media setup",
    );
    expect(transport.managed).not.toHaveBeenCalled();
    expect(transport.single).not.toHaveBeenCalled();
    expect(transport.multiple).not.toHaveBeenCalled();
  });

  it("preserves custom artifact handling for non-managed image siblings", async () => {
    const req = request({ model: "custom-vision" });
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    const model = provider?.models[0];
    if (!provider || !model) {
      throw new Error("fixture provider missing");
    }
    provider.models.push({
      ...model,
      id: req.model,
      params: { modelPath: "hf:custom/model/model.gguf", mmprojPath: "/custom/mmproj.gguf" },
    });
    await providerMethods().multiple(req);
    expect(transport.multiple).toHaveBeenCalledExactlyOnceWith(req);
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "openai" },
    { id: OCR },
    { baseUrl: "https://cloud.example.test/v1" },
    { baseUrl: "http://127.0.0.1:19433/v1" },
  ])("blocks a prepared runtime's changed final transport target: %j", async (override) => {
    const req = request();
    req.preparedModelRuntime = {
      agentDir: req.agentDir,
      config: req.cfg,
      createStores: () => ({}),
    };
    const send = vi.fn();
    transport.managed.mockImplementationOnce(async (_req, transform) => {
      if (!transform) {
        throw new Error("fixture transform missing");
      }
      await transform(
        { messages: [{ role: "user", content: [] }] },
        { ...REQUEST_MODEL, ...override },
      );
      send();
      return { text: "unexpected request" };
    });
    await expect(providerMethods().multiple(req)).rejects.toThrow(
      "resolved local image model must match",
    );
    expect(send).not.toHaveBeenCalled();
    expect(transport.single).not.toHaveBeenCalled();
    expect(transport.multiple).not.toHaveBeenCalled();
  });

  it("rejects an explicit proxy before image transport without changing provider settings", async () => {
    const req = request();
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    provider.request = {
      proxy: { mode: "explicit-proxy", url: "http://proxy.example.test:8080" },
    };
    const previous = structuredClone(provider);
    await expect(providerMethods().multiple(req)).rejects.toThrow(
      "Remove models.providers.llama-cpp.request.proxy",
    );
    expect(provider).toEqual(previous);
    expect(transport.managed).not.toHaveBeenCalled();
    expect(transport.single).not.toHaveBeenCalled();
    expect(transport.multiple).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects environment proxy routing (configured=%s)",
    async (configured) => {
      vi.stubEnv("http_proxy", "http://proxy.example.test:8080");
      vi.stubEnv("no_proxy", "");
      const req = request();
      const provider = req.cfg.models?.providers?.["llama-cpp"];
      if (!provider) {
        throw new Error("fixture provider missing");
      }
      if (configured) {
        provider.request = { proxy: { mode: "env-proxy" } };
      }
      const original = {
        ...structuredClone(req),
        images: req.images.map((image) => ({ ...image, buffer: Buffer.from(image.buffer) })),
      };
      await expect(providerMethods().multiple(req)).rejects.toThrow("NO_PROXY");
      expect(transport.managed).not.toHaveBeenCalled();
      expect(transport.multiple).not.toHaveBeenCalled();
      expect(req).toEqual(original);
      expect(req.images[0]?.buffer).toBe(IMAGE);
      vi.stubEnv("no_proxy", "127.0.0.1");
      await expect(providerMethods().multiple(req)).resolves.toEqual({ text: "local result" });
    },
  );

  it.each([false, true])(
    "rechecks an environment proxy enabled during model preparation (bypassed=%s)",
    async (bypassed) => {
      const send = vi.fn();
      transport.managed.mockImplementationOnce(async (_req, transform) => {
        await Promise.resolve();
        vi.stubEnv("http_proxy", "http://proxy.example.test:8080");
        vi.stubEnv("no_proxy", bypassed ? "127.0.0.1" : "");
        if (!transform) {
          throw new Error("fixture transform missing");
        }
        await transform({ messages: [{ role: "user", content: [] }] }, REQUEST_MODEL);
        send();
        return { text: "local result" };
      });
      const result = providerMethods().multiple(request());
      if (bypassed) {
        await expect(result).resolves.toEqual({ text: "local result" });
        expect(send).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toThrow("NO_PROXY");
        expect(send).not.toHaveBeenCalled();
      }
      expect(transport.single).not.toHaveBeenCalled();
      expect(transport.multiple).not.toHaveBeenCalled();
    },
  );

  it("rejects a retained runtime's explicit proxy before transport", async () => {
    const req = request();
    const config = structuredClone(req.cfg);
    const provider = config.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    provider.request = {
      proxy: { mode: "explicit-proxy", url: "http://proxy.example.test:8080" },
    };
    req.preparedModelRuntime = { agentDir: req.agentDir, config, createStores: () => ({}) };
    await expect(providerMethods().multiple(req)).rejects.toThrow("direct loopback");
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each(["modelPath", "mmprojPath"] as const)(
    "rejects a retained runtime's changed %s before transport",
    async (field) => {
      const req = request();
      const config = structuredClone(req.cfg);
      const model = config.models?.providers?.["llama-cpp"]?.models.find(
        (entry) => entry.id === req.model,
      );
      if (!model) {
        throw new Error("fixture model missing");
      }
      model.params = { ...model.params, [field]: "hf:custom/model/other.gguf" };
      req.preparedModelRuntime = { agentDir: req.agentDir, config, createStores: () => ({}) };
      await expect(providerMethods().multiple(req)).rejects.toThrow("verified recipe artifacts");
      expect(transport.managed).not.toHaveBeenCalled();
    },
  );

  it("rejects a retained runtime's changed loopback endpoint before transport", async () => {
    const req = request();
    const config = structuredClone(req.cfg);
    const provider = config.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    provider.baseUrl = "http://127.0.0.1:19433/v1";
    req.preparedModelRuntime = { agentDir: req.agentDir, config, createStores: () => ({}) };
    await expect(providerMethods().multiple(req)).rejects.toThrow("endpoint must match");
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each([
    { ocr: VISION, vision: OCR },
    { ocr: OCR, vision: OCR },
  ])("rejects role-incompatible recipe selections", async (mediaModels) => {
    const req = request({ model: OCR });
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    provider.params = { mediaModels };
    await expect(providerMethods().multiple(req)).rejects.toThrow("recipe is unavailable");
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ buffer: Buffer.alloc(0), fileName: "empty.png" }],
    [{ buffer: Buffer.alloc(LLAMA_CPP_MEDIA_MAX_BYTES + 1), fileName: "large.png" }],
    [
      { buffer: IMAGE, fileName: "one.png" },
      { buffer: IMAGE, fileName: "two.png" },
    ],
  ])("rejects empty, oversized, or multiple image input before transport", async (...images) => {
    await expect(providerMethods().multiple(request({ images }))).rejects.toThrow();
    expect(transport.managed).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid output token budget %s",
    async (maxTokens) => {
      await expect(providerMethods().multiple(request({ maxTokens }))).rejects.toThrow(
        "positive finite",
      );
      expect(transport.managed).not.toHaveBeenCalled();
    },
  );

  it.each([
    [12.9, 12],
    [99_999, LLAMA_CPP_MEDIA_MAX_TOKENS],
  ])("bounds a requested token budget %s to %s", async (maxTokens, expected) => {
    await providerMethods().multiple(request({ maxTokens }));
    expect(transport.managed).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: expected }),
      expect.any(Function),
    );
  });

  it("bounds OCR output without splitting a Unicode surrogate pair", async () => {
    transport.managed.mockResolvedValueOnce({
      text: "x".repeat(LLAMA_CPP_MEDIA_MAX_CHARS - 1) + "😀tail",
    });
    const result = await providerMethods().multiple(request({ model: OCR }));
    expect(result.text).toBe("x".repeat(LLAMA_CPP_MEDIA_MAX_CHARS - 1));
  });

  it("carries cancellation to shared inference and refuses results after cancellation", async () => {
    const hooks = providerMethods();
    const before = new AbortController();
    before.abort();
    await expect(hooks.multiple(request({ signal: before.signal }))).rejects.toThrow();
    expect(transport.managed).not.toHaveBeenCalled();
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
    const provider = req.cfg.models?.providers?.["llama-cpp"];
    if (!provider) {
      throw new Error("fixture provider missing");
    }
    provider.params = { mediaModels: { ocr: OCR, vision: "missing-recipe" } };
    provider.models.push({ ...provider.models[0]!, id: "missing-recipe" });
    await expect(providerMethods().multiple({ ...req, model: "missing-recipe" })).rejects.toThrow(
      "recipe is unavailable",
    );
    expect(transport.managed).toHaveBeenCalledTimes(1);
  });
});
