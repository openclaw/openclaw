import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  pollProviderOperationJson,
  postJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
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

function generateVideo(cfg: OpenClawConfig) {
  return provider.generateVideo({ provider: "runway", model: "gen4.5", prompt: "lobster", cfg });
}

function privateNetworkConfig(
  allowPrivateNetwork: boolean,
  baseUrl = "https://api.dev.runwayml.com",
) {
  return {
    models: { providers: { runway: { baseUrl, models: [], request: { allowPrivateNetwork } } } },
  };
}

async function expectBlocked(cfg: OpenClawConfig) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unguarded fetch"));
  await expect(generateVideo(cfg)).rejects.toMatchObject({ name: "SsrFBlockedError" });
  expect(fetchMock).not.toHaveBeenCalled();
}

it("applies configured request policy to the submitted Runway task", async () => {
  const intercepted = new Error("synthetic submission intercepted");
  postJsonResponseMock.mockRejectedValue(intercepted);

  await expect(
    generateVideo(createProxyRequestModelProviderConfig("runway", "https://runway.example.test")),
  ).rejects.toBe(intercepted);

  expect(postJsonResponseMock).toHaveBeenCalledOnce();
  const request = postJsonResponseMock.mock.calls[0]?.[0];
  assert(request);
  expect(request).toMatchObject({
    url: "https://runway.example.test/v1/text_to_video",
    allowPrivateNetwork: true,
    dispatcherPolicy: { mode: "explicit-proxy", proxyUrl: "http://proxy.example:8080" },
  });
  expect(Object.fromEntries(new Headers(request.headers))).toMatchObject({
    authorization: "Bearer synthetic-runway-key",
    "content-type": "application/json",
    "x-runway-version": "2024-11-06",
    "x-relay": "synthetic-route",
  });
});

it("denies private polling without needing a proxy override", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  pollMock.mockImplementation(actual.pollProviderOperationJson);
  postJsonResponseMock.mockResolvedValue({ id: "synthetic-task" });
  await expectBlocked(privateNetworkConfig(false, "http://127.0.0.1:9"));
});

it.each(["http://127.0.0.1:9/video.mp4", "http://10.0.0.1/video.mp4"])(
  "blocks private result URL %s even when task trust allows private hosts",
  async (url) => {
    postJsonResponseMock.mockResolvedValue({ id: "synthetic-task" });
    pollMock.mockResolvedValue({ status: "SUCCEEDED", output: [url] });
    await expectBlocked(privateNetworkConfig(true));
  },
);
