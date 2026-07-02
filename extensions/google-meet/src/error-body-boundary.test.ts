import { afterEach, describe, expect, it, vi } from "vitest";

// Replace fetchWithSsrFGuard with a lightweight pass-through so the test
// can drive fetch against synthetic Response objects.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await fetch(params.url, { ...params.init, signal: params.signal }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

const SEVENTEEN_MIB = 17 * 1024 * 1024;

describe("google-meet response body boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects oversized spaces.get response on 200 success path via readProviderJsonResponse", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(SEVENTEEN_MIB).fill(0x58), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { fetchGoogleMeetSpace } = await import("./meet.js");
    const error = await fetchGoogleMeetSpace({
      accessToken: "fake-token",
      meeting: "abc-defg",
    }).catch((e: unknown) => e);

    const msg = error instanceof Error ? error.message : String(error);
    // readProviderJsonResponse rejects response bodies exceeding its 16 MiB cap.
    expect(msg).toContain("Google Meet spaces.get");
    expect(msg).toContain("exceeds");
  });

  it("passes valid spaces.get response through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "spaces/valid-test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { fetchGoogleMeetSpace } = await import("./meet.js");
    const result = await fetchGoogleMeetSpace({
      accessToken: "fake-token",
      meeting: "valid-test",
    });

    expect(result.name).toBe("spaces/valid-test");
  });
});
