import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: vi.fn(() => ({ version: "2026.3.19" })),
}));

import { fetchGraphJson } from "./graph.js";
import { resetUserAgentCache } from "./user-agent.js";

describe("fetchGraphJson User-Agent", () => {
  afterEach(() => {
    resetUserAgentCache();
    vi.restoreAllMocks();
  });

  it("sends User-Agent header with OpenClaw version", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchGraphJson({ token: "test-token", path: "/groups" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/.+ OpenClaw\/2026\.3\.19$/);
    expect(init.headers).toHaveProperty("Authorization", "Bearer test-token");

    vi.unstubAllGlobals();
  });

  it("allows caller headers to override User-Agent", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchGraphJson({
      token: "test-token",
      path: "/groups",
      headers: { "User-Agent": "custom-agent/1.0" },
    });

    const [, init] = mockFetch.mock.calls[0];
    // Caller headers spread after, so they override
    expect(init.headers["User-Agent"]).toBe("custom-agent/1.0");

    vi.unstubAllGlobals();
  });
});
