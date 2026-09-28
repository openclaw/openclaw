import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { CHUTES_BASE_URL, discoverChutesModels } from "./models.js";

afterEach(() => {
  vi.unstubAllEnvs();
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("Chutes model discovery proxy policy", () => {
  it("allows the guarded official catalog request to use an eligible HTTP proxy", async () => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "development");
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("unavailable", { status: 503 }),
      release,
      finalUrl: `${CHUTES_BASE_URL}/models`,
    });

    await discoverChutesModels("test-token");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: `${CHUTES_BASE_URL}/models`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
