import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";
import {
  mockPinnedHostnameResolution,
  PROXY_FIXTURE_HOST,
  PROXY_FIXTURE_PAYLOAD,
  withProxyFixture,
} from "openclaw/plugin-sdk/test-env";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import { buildFalMusicGenerationProvider } from "./music-generation-provider.js";

const { postJsonResponse } = vi.hoisted(() => ({ postJsonResponse: vi.fn() }));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-fal-key" }),
}));
vi.mock("openclaw/plugin-sdk/provider-http", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonResponse,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("downloads public audio through the ambient HTTP proxy with strict DNS admission", async () => {
  await withProxyFixture(async (fixture) => {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      vi.stubEnv(key, fixture.httpProxy);
    }
    for (const key of ["NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "OPENCLAW_PROXY_ACTIVE"]) {
      vi.stubEnv(key, "");
    }
    const previousDispatcher = getGlobalDispatcher();
    const lookup = mockPinnedHostnameResolution();
    ensureGlobalUndiciEnvProxyDispatcher();
    const dispatcher = getGlobalDispatcher();
    try {
      postJsonResponse.mockResolvedValue({
        audio_file: { url: `http://${PROXY_FIXTURE_HOST}/media` },
      });
      const result = await buildFalMusicGenerationProvider().generateMusic({
        provider: "fal",
        model: "fal-ai/minimax-music/v2.6",
        prompt: "synthetic proxy route",
        cfg: {},
        timeoutMs: 1_000,
      });
      expect(result.tracks[0]?.buffer.toString()).toBe(PROXY_FIXTURE_PAYLOAD);
      expect(fixture.originRoutes).toEqual(["proxy"]);
      expect(fixture.connections).toEqual(["http:files.proxy.test"]);

      lookup.mockRestore();
      mockPinnedHostnameResolution(["127.0.0.1"]);
      await expect(
        buildFalMusicGenerationProvider().generateMusic({
          provider: "fal",
          model: "fal-ai/minimax-music/v2.6",
          prompt: "synthetic private DNS",
          cfg: {},
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ name: "SsrFBlockedError" });
      expect(fixture.originRoutes).toEqual(["proxy"]);
      expect(fixture.connections).toEqual(["http:files.proxy.test"]);
    } finally {
      setGlobalDispatcher(previousDispatcher);
      if (dispatcher !== previousDispatcher) {
        await dispatcher.close();
      }
    }
  });
});
