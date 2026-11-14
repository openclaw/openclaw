import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { jsonResponse, mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { googleImageGenerationProvider } from "./image-generation-provider.js";

function generateImage(overrides: Partial<ImageGenerationRequest> = {}) {
  return googleImageGenerationProvider.generateImage({
    provider: "google",
    model: "gemini-3.1-flash-image",
    prompt: "draw a cat",
    cfg: {},
    ...overrides,
  });
}

function googleImageConfig(provider: Omit<ModelProviderConfig, "models">) {
  return { models: { providers: { google: { ...provider, models: [] } } } };
}

function googleImagePayload(parts: unknown[]) {
  return { candidates: [{ content: { parts } }] };
}
function inlineImage(data: Buffer | string, mimeType = "image/png") {
  return { inlineData: { mimeType, data: Buffer.isBuffer(data) ? data.toString("base64") : data } };
}

let ssrfMock: { mockRestore: () => void } | undefined;

function installGoogleFetchMock(
  payload: unknown = googleImagePayload([inlineImage(Buffer.from("png-data"))]),
) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  expect(typeof url).toBe("string");
  if (!init) {
    throw new Error("Expected fetch init");
  }
  return { ...init, body: typeof init.body === "string" ? init.body : undefined, url };
}

function expectGenerationRequest(
  fetchMock: ReturnType<typeof vi.fn>,
  model: string,
  parts: unknown[],
  imageConfig: object,
) {
  const request = fetchRequest(fetchMock);
  expect(request.url).toBe(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  );
  expect(request.method).toBe("POST");
  expect(JSON.parse(request.body ?? "")).toEqual({
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig },
  });
}

beforeEach(() => {
  ssrfMock = mockPinnedHostnameResolution();
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-test-key",
    source: "env",
    mode: "api-key",
  });
});

afterEach(() => {
  ssrfMock?.mockRestore();
  ssrfMock = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("generates image buffers from the Gemini generateContent API", async () => {
  const imageBytes = Buffer.from([0xfb, 0xff, 0x50, 0x4e, 0x47]);
  const data = imageBytes.toString("base64url");
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: JSON.stringify({ token: "oauth-token" }),
    source: "profile",
    mode: "token",
  });
  const fetchMock = installGoogleFetchMock(
    googleImagePayload([
      { text: "generated" },
      inlineImage(data),
      { inline_data: { mime_type: "image/jpeg", data: imageBytes.toString("base64") } },
    ]),
  );

  const result = await generateImage({ size: "1536x1024" });

  expectGenerationRequest(fetchMock, "gemini-3.1-flash-image", [{ text: "draw a cat" }], {
    aspectRatio: "3:2",
    imageSize: "2K",
  });
  expect(new Headers(fetchRequest(fetchMock).headers).get("authorization")).toBe(
    "Bearer oauth-token",
  );
  expect(result).toEqual({
    images: [
      { buffer: imageBytes, mimeType: "image/png", fileName: "image-1.png" },
      { buffer: imageBytes, mimeType: "image/jpeg", fileName: "image-2.jpg" },
    ],
    model: "gemini-3.1-flash-image",
  });
});

it.each([
  [
    { ssrfPolicy: { allowRfc2544BenchmarkRange: true } },
    { ssrfPolicy: { allowRfc2544BenchmarkRange: true } },
  ],
  [
    {
      cfg: googleImageConfig({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        request: { allowPrivateNetwork: true },
      }),
    },
    { allowPrivateNetwork: true },
  ],
] satisfies Array<[Partial<ImageGenerationRequest>, object]>)(
  "forwards explicit network policy: %j",
  async (request, policy) => {
    installGoogleFetchMock();
    const post = vi.spyOn(providerHttp, "postJsonResponse");
    await generateImage(request);
    expect(post.mock.calls[0]?.[0]).toMatchObject(policy);
  },
);

it.each([
  ["wrong shape", { candidates: { content: { parts: [] } } }],
  ["invalid base64", googleImagePayload([inlineImage("not-base64!")])],
  ["mixed alphabets", googleImagePayload([inlineImage("aGVsbG8+_")])],
])("rejects malformed Gemini image responses: %s", async (_label, payload) => {
  installGoogleFetchMock(payload);
  await expect(generateImage({})).rejects.toThrow("Google image generation response malformed");
});

it("accepts multiple images above generic JSON and configured media caps", async () => {
  const image = Buffer.alloc(4 * 1024 * 1024, 1);
  installGoogleFetchMock(googleImagePayload(Array.from({ length: 3 }, () => inlineImage(image))));
  const result = await generateImage({
    cfg: { agents: { defaults: { mediaMaxMb: 0.5 } } },
  });
  expect(result.images.map((item) => item.buffer.byteLength)).toEqual(
    Array(3).fill(image.byteLength),
  );
});

const reference = {
  buffer: Buffer.from("reference-bytes"),
  mimeType: "image/png",
  fileName: "reference.png",
};
it.each([
  [
    { resolution: "4K", inputImages: [reference] },
    [inlineImage(reference.buffer)],
    { imageSize: "4K" },
  ],
  [{ aspectRatio: "9:16" }, [], { aspectRatio: "9:16" }],
] satisfies Array<[Partial<ImageGenerationRequest>, unknown[], object]>)(
  "sends explicit image settings without a default: %j",
  async (overrides, parts, imageConfig) => {
    const fetchMock = installGoogleFetchMock();
    await generateImage({ model: "gemini-3-pro-image", ...overrides });
    expectGenerationRequest(
      fetchMock,
      "gemini-3-pro-image",
      [...parts, { text: "draw a cat" }],
      imageConfig,
    );
  },
);
