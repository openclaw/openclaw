import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildFalImageGenerationProvider } from "./image-generation-provider.js";

function references(count = 1) {
  const buffer = Buffer.from("reference");
  return Array.from({ length: count }, () => ({ buffer, mimeType: "image/png" }));
}

function mockGeneratedImage() {
  fetchWithSsrFGuardMock.mockReset();
  for (const response of [
    Response.json({ images: [{ url: "https://v3.fal.media/out.webp" }] }),
    new Response("image", { headers: { "content-type": "image/webp" } }),
  ]) {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release: vi.fn(async () => {}) });
  }
}

const provider = buildFalImageGenerationProvider();
const target = { provider: "fal", model: "openai/gpt-image-2.5/flare/text-to-image" };
const defaults = () => ({ cfg: {}, prompt: "A sticker" });
function generate(req: Partial<Parameters<typeof generateImage>[0]>, warn?: () => void) {
  return generateImage(
    { ...defaults(), ...req },
    { getProvider: () => provider, listProviders: () => [provider], log: warn && { warn } },
  );
}

const auth = { apiKey: "fal-test-key", source: "env", mode: "api-key" } as const;
beforeEach(() => {
  vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue(auth);
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

it.each([
  ["1:1", 1536, 1536],
  ["5:4", 1536, 1232],
  ["4:5", 1232, 1536],
  ["2.35:1", 1536, 656],
  ["21:9", 1536, 656],
] as const)("maps %s to generation and edit dimensions", async (aspectRatio, width, height) => {
  for (const variant of ["flare", "sunburst"]) {
    mockGeneratedImage();
    await generate({
      modelOverride: `fal/openai/gpt-image-2.5/${variant}/text-to-image`,
      aspectRatio,
      ...(variant === "sunburst"
        ? { inputImages: references(), inferredResolution: "4K" as const }
        : {}),
    });
    const body = JSON.parse(String(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init.body));
    expect(body.image_size).toEqual({ width, height });
    expect(body).not.toHaveProperty("resolution");
  }
});

it.each(["flare", "sunburst"])("generates and edits %s through runtime", async (variant) => {
  const model = `openai/gpt-image-2.5/${variant}/text-to-image`;
  const editModel = model.replace("/text-to-image", "/edit");
  const refs = references(16);
  for (const mode of ["generate", "edit", "explicit-edit"] as const) {
    mockGeneratedImage();
    const result = await generate({
      modelOverride: `fal/${mode === "explicit-edit" ? editModel : model}`,
      prompt: "A transparent sticker",
      quality: variant === "flare" ? "xhigh" : "max",
      outputFormat: "webp",
      background: "transparent",
      size: mode === "generate" ? "1536x864" : "auto",
      ...(mode !== "generate" ? { inputImages: refs, inferredResolution: "4K" as const } : {}),
    });
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0].url).toBe(
      `https://fal.run/${mode === "generate" ? model : editModel}`,
    );
    expect(JSON.parse(String(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init.body))).toEqual({
      prompt: "A transparent sticker",
      num_images: 1,
      quality: variant === "flare" ? "xhigh" : "max",
      output_format: "webp",
      background: "transparent",
      image_size: mode === "generate" ? { width: 1536, height: 864 } : "auto",
      ...(mode !== "generate"
        ? { image_urls: Array.from({ length: 16 }, () => "data:image/png;base64,cmVmZXJlbmNl") }
        : {}),
    });
    expect(result.ignoredOverrides).toEqual([]);
  }
  fetchWithSsrFGuardMock.mockReset();
  await expect(
    generate({ modelOverride: `fal/${model}`, inputImages: references(17) }, vi.fn()),
  ).rejects.toThrow("16");
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

it.each([
  { size: "1025x1024" },
  { size: "1024x624" },
  { size: "4096x2048" },
  { size: "2896x2896" },
  { size: "3072x768" },
  { size: "bogus" },
  { aspectRatio: "4:1" },
  { resolution: "4K" as const },
])("rejects incompatible geometry before requesting fal: %j", async (geometry) => {
  await expect(provider.generateImage({ ...target, ...defaults(), ...geometry })).rejects.toThrow(
    /fal GPT Image 2.5.*size/,
  );
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

it("keeps edit auto geometry when no size is requested", async () => {
  mockGeneratedImage();
  await provider.generateImage({
    ...target,
    ...defaults(),
    model: "openai/gpt-image-2.5/sunburst/text-to-image",
    inputImages: references(),
  });
  const body = JSON.parse(String(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init.body));
  expect(body).not.toHaveProperty("image_size");
  expect(body).not.toHaveProperty("resolution");
});
