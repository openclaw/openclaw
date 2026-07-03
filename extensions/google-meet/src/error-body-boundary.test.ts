import http from "node:http";
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

import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { GoogleMeetSpace } from "./meet.js";

const SEVENTEEN_MIB = 17 * 1024 * 1024;
const PAYLOAD_OK = JSON.stringify({ name: "spaces/live-server-test" });

function startLocalServer(port: number, oversize: boolean): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (oversize) {
      res.end(new Uint8Array(SEVENTEEN_MIB).fill(0x58));
    } else {
      res.end(PAYLOAD_OK);
    }
  });
}

/**
 * Creates a fetch spy that routes Google Meet API URLs to a local TCP server.
 * The actual Google Meet functions construct URLs like
 * "https://meet.googleapis.com/v2/spaces/xyz" — this spy intercepts those
 * and fetches from the local server instead, while leaving non-Meet fetches
 * untouched (e.g. module resolution during import).
 */
function spyOnGoogleMeetFetch(port: number) {
  const originalFetch = globalThis.fetch;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("meet.googleapis.com")) {
        return originalFetch(`http://127.0.0.1:${port}/`, init);
      }
      // Pass through non-Meet URLs (module resolution, etc.)
      return originalFetch(input, init);
    });
}

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

  it("rejects oversized response through real HTTP transport (local TCP server → fetch → readProviderJsonResponse)", async () => {
    const server = startLocalServer(0, true);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as import("net").AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const error = await readProviderJsonResponse(response, "Google Meet transport proof").catch(
        (e: unknown) => e,
      );
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).toContain("exceeds");
    } finally {
      server.close();
    }
  });

  it("passes normal response through real HTTP transport (local TCP server → fetch → readProviderJsonResponse)", async () => {
    const server = startLocalServer(0, false);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as import("net").AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const result = await readProviderJsonResponse<{ name: string }>(
        response,
        "Google Meet transport proof",
      );
      expect(result.name).toBe("spaces/live-server-test");
    } finally {
      server.close();
    }
  });

  it("rejects oversized response through Google Meet function via real SSRF-guard local transport", async () => {
    const server = startLocalServer(0, true);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as import("net").AddressInfo).port;

    // Route meet.googleapis.com → local TCP server without mocking Response
    const fetchSpy = spyOnGoogleMeetFetch(port);

    try {
      const { fetchGoogleMeetSpace: fetchFn } = await import("./meet.js");
      const error = await fetchFn({
        accessToken: "fake-token",
        meeting: "abc-defg",
      }).catch((e: unknown) => e);

      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).toContain("Google Meet spaces.get");
      expect(msg).toContain("exceeds");
      // Verify the request actually went through our local server
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("meet.googleapis.com"),
        expect.anything(),
      );
    } finally {
      server.close();
    }
  });

  it("passes normal response through Google Meet function via real SSRF-guard local transport", async () => {
    const server = startLocalServer(0, false);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as import("net").AddressInfo).port;

    // Route meet.googleapis.com → local TCP server without mocking Response
    spyOnGoogleMeetFetch(port);

    try {
      const { fetchGoogleMeetSpace: fetchFn } = await import("./meet.js");
      const result: GoogleMeetSpace = await fetchFn({
        accessToken: "fake-token",
        meeting: "live-test",
      });

      expect(result.name).toBe("spaces/live-server-test");
    } finally {
      server.close();
    }
  });
});
