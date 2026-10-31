import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createProxyRequestModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import { buildFalVideoGenerationProvider } from "./video-generation-provider.js";

const { fetchGuardMock } = vi.hoisted(() => ({
  fetchGuardMock: vi.fn<typeof fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-provider-key" }),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuardMock,
}));

afterEach(() => vi.restoreAllMocks());

it("preserves configured task headers and proxy at the video submission boundary", async () => {
  const intercepted = new Error("synthetic submission intercepted");
  fetchGuardMock.mockRejectedValue(intercepted);

  await expect(
    buildFalVideoGenerationProvider().generateVideo({
      provider: "fal",
      model: "fal-ai/minimax/video-01-live",
      prompt: "a synthetic lobster",
      cfg: createProxyRequestModelProviderConfig("fal"),
    }),
  ).rejects.toBe(intercepted);

  expect(fetchGuardMock).toHaveBeenCalledOnce();
  const submitted = fetchGuardMock.mock.calls[0]?.[0];
  assert(submitted);
  expect(submitted.url).toBe("https://relay.example.test/fal-ai/minimax/video-01-live");
  expect(Object.fromEntries(new Headers(submitted.init?.headers))).toMatchObject({
    authorization: "Key synthetic-provider-key",
    "x-relay": "synthetic-route",
  });
  expect(submitted.dispatcherPolicy).toMatchObject({
    mode: "explicit-proxy",
    proxyUrl: "http://proxy.example:8080",
  });
  expect(submitted.policy?.allowPrivateNetwork).not.toBe(true);
});
