// Baseten proxy tests cover the live model discovery transport policy.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { BASETEN_BASE_URL, discoverBasetenModels } from "./models.js";

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

describe("Baseten model discovery proxy policy", () => {
  it("defaults the guarded catalog request to the trusted-env proxy preset", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("unavailable", { status: 503 }),
      release,
      finalUrl: `${BASETEN_BASE_URL}/models`,
    });

    // No injected fetchGuard: exercise the production default caller path.
    await discoverBasetenModels({ discoveryApiKey: "test-token", forceLive: true });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_env_proxy",
        url: `${BASETEN_BASE_URL}/models`,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
