// OpenRouter proxy tests cover the live model discovery transport policy.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildOpenrouterLiveProvider, OPENROUTER_BASE_URL } from "./provider-catalog.js";

afterEach(() => {
  clearLiveCatalogCacheForTests();
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("OpenRouter model discovery proxy policy", () => {
  it("allows the guarded official catalog request to use an eligible HTTP proxy", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("unavailable", { status: 400 }),
      release,
      finalUrl: `${OPENROUTER_BASE_URL}/models`,
    });

    await buildOpenrouterLiveProvider({ apiKey: "test-token" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: `${OPENROUTER_BASE_URL}/models`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
