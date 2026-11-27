import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { assert, expect, it, vi } from "vitest";
import plugin from "./index.js";

const imageSdkLoaded = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/image-generation", async (importOriginal) => {
  imageSdkLoaded();
  return importOriginal<typeof import("openclaw/plugin-sdk/image-generation")>();
});

it("registers image capabilities and catalog discovery before loading image execution", async () => {
  const captured = createCapturedPluginRegistration();
  plugin.register?.(captured.api);
  const provider = captured.imageGenerationProviders.find((entry) => entry.id === "clawrouter");
  assert(provider);
  expect(provider.models).toEqual([]);
  expect(Object.keys(provider.capabilitiesByModel ?? {}).toSorted()).toEqual([
    "google/gemini-3-pro-image",
    "google/gemini-3.1-flash-image",
  ]);
  expect(
    captured.modelCatalogProviders.find((entry) => entry.kinds.includes("image_generation")),
  ).toMatchObject({ provider: "clawrouter", liveCatalog: expect.any(Function) });
  expect(imageSdkLoaded).not.toHaveBeenCalled();

  await expect(
    provider.generateImage({
      provider: "clawrouter",
      cfg: {},
      model: "unsupported",
      prompt: "test",
    }),
  ).rejects.toThrow("Unsupported ClawRouter image model");
  expect(imageSdkLoaded).toHaveBeenCalledOnce();
});
