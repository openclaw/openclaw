import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  pollProviderOperationJson,
  postJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createProxyRequestModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import plugin from "./index.js";

const { postJsonResponseMock, pollMock } = vi.hoisted(() => ({
  postJsonResponseMock: vi.fn<typeof postJsonResponse>(),
  pollMock: vi.fn<typeof pollProviderOperationJson>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-runway-key" }),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonResponse: postJsonResponseMock,
  pollProviderOperationJson: pollMock,
}));

afterEach(() => vi.restoreAllMocks());

const provider = requireRegisteredProvider(
  capturePluginRegistration(plugin).videoGenerationProviders,
  "runway",
);

it("applies configured request policy to the submitted Runway task", async () => {
  const intercepted = new Error("synthetic submission intercepted");
  postJsonResponseMock.mockRejectedValue(intercepted);

  await expect(
    provider.generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a synthetic lobster",
      cfg: createProxyRequestModelProviderConfig("runway", "https://runway.example.test"),
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
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  pollMock.mockImplementation(actual.pollProviderOperationJson);
  postJsonResponseMock.mockResolvedValue({ id: "synthetic-task" });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unguarded synthetic poll reached fetch"));

  await expect(
    provider.generateVideo({
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

it.each(["http://127.0.0.1:9/video.mp4", "http://10.0.0.1/video.mp4"])(
  "blocks generated result URL %s before connecting, even when task trust allows private hosts",
  async (url) => {
    postJsonResponseMock.mockResolvedValue({ id: "synthetic-task" });
    pollMock.mockResolvedValue({ status: "SUCCEEDED", output: [url] });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unguarded download reached fetch"));

    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "a synthetic lobster",
        cfg: {
          models: {
            providers: {
              runway: {
                baseUrl: "https://api.dev.runwayml.com",
                models: [],
                request: { allowPrivateNetwork: true },
              },
            },
          },
        },
      }),
    ).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it("blocks a public generated result redirect to a private host", async () => {
  postJsonResponseMock.mockResolvedValue({ id: "synthetic-task" });
  pollMock.mockResolvedValue({
    status: "SUCCEEDED",
    output: ["http://93.184.216.34/video.mp4"],
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:9/private.mp4" },
    }),
  );

  await expect(
    provider.generateVideo({
      provider: "runway",
      model: "gen4.5",
      cfg: {},
      prompt: "a synthetic lobster",
    }),
  ).rejects.toMatchObject({ name: "SsrFBlockedError" });
  expect(fetchMock).toHaveBeenCalledOnce();
});
