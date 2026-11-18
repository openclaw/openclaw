import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue(auth);
  fetchWithSsrFGuardMock.mockReset();
  for (const response of [
    Response.json({ images: [{ url: "https://v3.fal.media/out.webp" }] }),
    new Response("image", { headers: { "content-type": "image/webp" } }),
  ]) {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release: vi.fn(async () => {}) });
  }
});

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
afterEach(() => vi.restoreAllMocks());

it.each([
  ["5:4", 1536, 1232, false],
  ["4:5", 1232, 1536, true],
  ["2.35:1", 1536, 656, true],
] as const)("maps %s to dimensions", async (aspectRatio, width, height, edit) => {
  await generate({
    modelOverride: `fal/${target.model}`,
    aspectRatio,
    ...(edit ? { inputImages: references(), inferredResolution: "4K" as const } : {}),
  });
  const body = JSON.parse(String(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init.body));
  expect(body.image_size).toEqual({ width, height });
  expect(body).not.toHaveProperty("resolution");
});

it.each([
  ["flare", "generate"],
  ["sunburst", "edit"],
  ["flare", "explicit-edit"],
  ["sunburst", "default-edit"],
] as const)("routes %s %s through runtime", async (variant, mode) => {
  const model = `openai/gpt-image-2.5/${variant}/text-to-image`;
  const editModel = model.replace("/text-to-image", "/edit");
  const edit = mode !== "generate";
  const size = mode === "default-edit" ? undefined : edit ? "auto" : "1536x864";
  const quality = variant === "flare" ? "xhigh" : "max";
  const referenceUrl = "data:image/png;base64,cmVmZXJlbmNl";
  const result = await generate({
    modelOverride: `fal/${mode === "generate" || mode === "edit" ? model : editModel}`,
    quality,
    size,
    outputFormat: "webp",
    background: "transparent",
    ...(edit ? { inputImages: references(16), inferredResolution: "4K" as const } : {}),
  });
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
  assert(request, "Expected an image generation request");
  expect(request.url).toBe(`https://fal.run/${edit ? editModel : model}`);
  expect(JSON.parse(String(request.init.body))).toEqual({
    prompt: "A sticker",
    num_images: 1,
    quality,
    output_format: "webp",
    background: "transparent",
    ...(size ? { image_size: edit ? "auto" : { width: 1536, height: 864 } } : {}),
    ...(edit ? { image_urls: Array(16).fill(referenceUrl) } : {}),
  });
  expect(result.ignoredOverrides).toEqual([]);
});

it.each(["flare", "sunburst"])("rejects more than 16 %s references", async (variant) => {
  const modelOverride = `fal/openai/gpt-image-2.5/${variant}/text-to-image`;
  await expect(generate({ modelOverride, inputImages: references(17) }, vi.fn())).rejects.toThrow(
    "16",
  );
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
