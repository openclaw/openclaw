import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import googlePlugin from "./index.js";

const runtime = vi.hoisted(() => {
  const generateImage = vi.fn<ImageGenerationProvider["generateImage"]>();
  return {
    moduleLoads: 0,
    generateImage,
    buildProvider: vi.fn(() => ({ generateImage })),
  };
});

vi.mock("./image-generation-provider.js", () => {
  runtime.moduleLoads += 1;
  return { buildGoogleImageGenerationProvider: runtime.buildProvider };
});

function registerImageProvider() {
  const captured = createCapturedPluginRegistration({ id: "google" });
  googlePlugin.register(captured.api);
  const provider = captured.imageGenerationProviders.find((entry) => entry.id === "google");
  if (!provider) {
    throw new Error("Expected the registered Google image provider");
  }
  return provider;
}

it("registers independent image metadata without loading the runtime and delegates generation", async () => {
  const provider = registerImageProvider();
  const { generateImage: _generateImage, ...metadata } = provider;
  const expectedMetadata = {
    id: "google",
    label: "Google",
    defaultModel: "gemini-3.1-flash-image",
    models: ["gemini-3.1-flash-image", "gemini-3-pro-image"],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        resolutions: ["1K", "2K", "4K"],
      },
    },
  };
  expect(JSON.stringify(metadata)).toBe(JSON.stringify(expectedMetadata));
  expect(Object.hasOwn(provider, "isConfigured")).toBe(false);

  const second = registerImageProvider();
  second.models?.push("fixture-mutated-model");
  second.capabilities.generate.maxCount = 99;
  second.capabilities.edit.maxInputImages = 99;
  second.capabilities.geometry?.sizes?.push("fixture-mutated-size");
  second.capabilities.geometry?.aspectRatios?.push("fixture-mutated-ratio");
  second.capabilities.geometry?.resolutions?.push("4K");
  expect(JSON.stringify(metadata)).toBe(JSON.stringify(expectedMetadata));
  expect(runtime.moduleLoads).toBe(0);
  expect(runtime.buildProvider).not.toHaveBeenCalled();

  const request: ImageGenerationRequest = {
    provider: "google",
    model: "gemini-3-pro-image",
    prompt: "Synthetic registration boundary fixture",
    cfg: {},
    size: "1536x1024",
    inputImages: [{ buffer: Buffer.from("fixture-reference"), mimeType: "image/png" }],
  };
  const result = {
    images: [{ buffer: Buffer.from("fixture-result"), mimeType: "image/png" }],
    model: request.model,
  };
  runtime.generateImage.mockResolvedValue(result);
  const secondRequest = { ...request, prompt: "Second synthetic request" };
  expect(
    await Promise.all([provider.generateImage(request), second.generateImage(secondRequest)]),
  ).toEqual([result, result]);
  expect(runtime.moduleLoads).toBe(1);
  expect(runtime.buildProvider).toHaveBeenCalledOnce();
  expect(runtime.generateImage).toHaveBeenNthCalledWith(1, request);
  expect(runtime.generateImage).toHaveBeenNthCalledWith(2, secondRequest);
});
