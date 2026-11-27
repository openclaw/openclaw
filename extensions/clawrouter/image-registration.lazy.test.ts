import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { assert, expect, it, vi } from "vitest";
import plugin from "./index.js";

const imageSdk = vi.hoisted(() => ({
  loaded: vi.fn(),
  entered: Promise.withResolvers<void>(),
  hold: undefined as Promise<void> | undefined,
}));
vi.mock("openclaw/plugin-sdk/image-generation", async (importOriginal) => {
  imageSdk.loaded();
  imageSdk.entered.resolve();
  await imageSdk.hold;
  return importOriginal<typeof import("openclaw/plugin-sdk/image-generation")>();
});

it("keeps registration synchronous and charges cold image loading to each caller's budget", async () => {
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

  const request = {
    provider: "clawrouter",
    cfg: {},
    prompt: "a square",
    model: "openai/gpt-image-2.5-flare",
    timeoutMs: 60_000,
  };
  const abort = new Error("caller cancelled before loading");
  await expect(
    provider.generateImage({ ...request, signal: AbortSignal.abort(abort) }),
  ).rejects.toBe(abort);
  expect(imageSdk.loaded).not.toHaveBeenCalled();

  const release = Promise.withResolvers<void>();
  imageSdk.hold = release.promise;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected image request"));
  const clock = vi.spyOn(performance, "now");
  try {
    const requests = Promise.allSettled([
      provider.generateImage(request),
      provider.generateImage({ ...request, model: "google/gemini-3-pro-image" }),
    ]);
    await imageSdk.entered.promise;
    clock.mockReturnValue(performance.now() + request.timeoutMs + 1);
    release.resolve();
    expect(await requests).toEqual([
      {
        status: "rejected",
        reason: new Error("ClawRouter image generation timed out after 60000ms"),
      },
      { status: "rejected", reason: new Error("ClawRouter Google images timed out after 60000ms") },
    ]);
    expect(imageSdk.loaded).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    clock.mockRestore();
    fetchSpy.mockRestore();
  }
});
