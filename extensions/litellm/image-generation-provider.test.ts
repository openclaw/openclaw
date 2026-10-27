import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";

const { resolveApiKeyForProviderMock, postJsonRequestMock, postMultipartRequestMock } =
  getProviderHttpMocks();

installProviderHttpMockCleanup();

const generate = (overrides: Partial<ImageGenerationRequest> = {}) =>
  buildLitellmImageGenerationProvider().generateImage({
    provider: "litellm",
    model: "gpt-image-2",
    prompt: "Draw a QA lighthouse",
    cfg: {},
    ...overrides,
  });
const proxyConfig = (baseUrl: string, request?: { allowPrivateNetwork: boolean }) => ({
  models: { providers: { litellm: { baseUrl, request, models: [] } } },
});

function mockObjectArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const arg = mock.mock.calls.at(-1)?.[0];
  assert(arg && typeof arg === "object");
  return arg as Record<string, unknown>;
}

beforeEach(() => {
  resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "litellm-key" });
  const pngResponse = () => ({
    response: Response.json({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] }),
    release: vi.fn(async () => {}),
  });
  postJsonRequestMock.mockImplementation(pngResponse);
  postMultipartRequestMock.mockImplementation(pngResponse);
});

it("forwards count and size overrides on generation requests", async () => {
  const body = { model: "dall-e-3", prompt: "two landscape variants", n: 2, size: "3840x2160" };
  const { n: count, ...request } = body;
  await generate({ ...request, count });
  expect(mockObjectArg(postJsonRequestMock)).toMatchObject({
    url: "http://localhost:4000/images/generations",
    allowPrivateNetwork: true,
  });
  expect(mockObjectArg(postJsonRequestMock).body).toEqual(body);
});

it.each([1, 2])("uploads %i reference images as multipart", async (count) => {
  const inputImages = [
    { buffer: Buffer.from("first"), mimeType: "image/png" },
    { buffer: Buffer.from("second"), mimeType: "image/jpeg" },
  ].slice(0, count);
  await generate({ prompt: "refine the hero", inputImages });
  // LiteLLM rejects JSON edits; single and multiple uploads use different part names.
  expect(postJsonRequestMock).not.toHaveBeenCalled();
  const request = mockObjectArg(postMultipartRequestMock);
  expect(request.url).toBe("http://localhost:4000/images/edits");
  const form = request.body as FormData;
  expect(form.get("model")).toBe("gpt-image-2");
  expect(form.get("prompt")).toBe("refine the hero");
  expect(form.getAll(count === 1 ? "image[]" : "image")).toHaveLength(0);
  const images = form.getAll(count === 1 ? "image" : "image[]");
  expect(
    await Promise.all(
      images.map(async (image) => {
        assert(image instanceof Blob);
        return { buffer: Buffer.from(await image.arrayBuffer()), mimeType: image.type };
      }),
    ),
  ).toEqual(inputImages);
});

it.each([
  ["http://127.255.255.254:4000", true],
  ["http://[::1]:4000", true],
  ["http://[0:0:0:0:0:0:0:1]:4000", true],
  ["http://host.docker.internal:4000", true],
  ["https://localhost:4000", true],
  ["https://LOCALHOST:4000", true],
  ["http://proxy.localhost:4000", true],
  ["http://192.168.5.10:4000", undefined],
  ["http://printer.local:4000", undefined],
  ["http://127.evil.com:4000", undefined],
  ["http://[::ffff:127.0.0.1]:4000", undefined],
  ["https://evil.example.com/?target=host.docker.internal", undefined],
  ["https://evil.example.com/host.docker.internal/foo", undefined],
  ["https://public-api.openai.com/v1", undefined],
] as const)("sets automatic private-network policy for %s to %s", async (baseUrl, allow) => {
  await generate({ cfg: proxyConfig(baseUrl) });
  expect(mockObjectArg(postJsonRequestMock).allowPrivateNetwork).toBe(allow === true);
});

it("honors explicit private-network opt-in for a non-loopback hostname", async () => {
  await generate({ cfg: proxyConfig("http://127.evil.com:4000", { allowPrivateNetwork: true }) });
  expect(mockObjectArg(postJsonRequestMock).allowPrivateNetwork).toBe(true);
});
