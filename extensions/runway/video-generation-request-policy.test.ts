import type { postJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { afterEach, assert, expect, it, vi } from "vitest";
import { buildRunwayVideoGenerationProvider } from "./video-generation-provider.js";

const { postJsonResponseMock } = vi.hoisted(() => ({
  postJsonResponseMock: vi.fn<typeof postJsonResponse>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-runway-key" }),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonResponse: postJsonResponseMock,
}));

afterEach(() => vi.restoreAllMocks());

it("applies configured request policy to the submitted Runway task", async () => {
  const intercepted = new Error("synthetic submission intercepted");
  postJsonResponseMock.mockRejectedValue(intercepted);

  await expect(
    buildRunwayVideoGenerationProvider().generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a synthetic lobster",
      cfg: {
        models: {
          providers: {
            runway: {
              baseUrl: "https://runway.example.test",
              models: [],
              request: {
                headers: { "X-Relay": "synthetic-route" },
                proxy: { mode: "explicit-proxy", url: "http://proxy.example:8080" },
                allowPrivateNetwork: true,
              },
            },
          },
        },
      },
    }),
  ).rejects.toBe(intercepted);

  expect(postJsonResponseMock).toHaveBeenCalledOnce();
  const request = postJsonResponseMock.mock.calls[0]?.[0];
  assert(request);
  expect(request.url).toBe("https://runway.example.test/v1/text_to_video");
  expect(Object.fromEntries(new Headers(request.headers))).toMatchObject({
    authorization: "Bearer synthetic-runway-key",
    "content-type": "application/json",
    "x-runway-version": "2024-11-06",
    "x-relay": "synthetic-route",
  });
  expect(request.allowPrivateNetwork).toBe(true);
  expect(request.dispatcherPolicy).toMatchObject({
    mode: "explicit-proxy",
    proxyUrl: "http://proxy.example:8080",
  });
});

it("denies private polling without needing a proxy override", async () => {
  postJsonResponseMock.mockResolvedValue({ id: "synthetic-task" });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unguarded synthetic poll reached fetch"));

  await expect(
    buildRunwayVideoGenerationProvider().generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a synthetic lobster",
      cfg: {
        models: {
          providers: {
            runway: {
              baseUrl: "http://127.0.0.1:9",
              models: [],
              request: { allowPrivateNetwork: false },
            },
          },
        },
      },
    }),
  ).rejects.toMatchObject({ name: "SsrFBlockedError" });
  expect(fetchMock).not.toHaveBeenCalled();
});
