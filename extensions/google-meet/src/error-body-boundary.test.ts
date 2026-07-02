import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace fetchWithSsrFGuard with a lightweight pass-through so the test
// can drive fetch against a real loopback HTTP server.
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

const origFetch = globalThis.fetch;

const CHUNK = Buffer.alloc(64 * 1024, "X");

describe("google-meet response body boundary", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      let written = 0;
      function write() {
        if (written >= 4 * 1024 * 1024) {
          res.end();
          return;
        }
        const ok = res.write(CHUNK);
        written += CHUNK.length;
        if (ok) {
          setImmediate(write);
        } else {
          res.once("drain", write);
        }
      }
      write();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("bounds fetchGoogleMeetSpace oversized response body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("meet.googleapis.com")) {
        return await origFetch(`http://127.0.0.1:${port}/does-not-matter`, init);
      }
      return await origFetch(input, init);
    });

    const { fetchGoogleMeetSpace } = await import("./meet.js");
    const error = await fetchGoogleMeetSpace({
      accessToken: "fake-token",
      meeting: "abc-defg",
    }).catch((e: unknown) => e);

    const msg = error instanceof Error ? error.message : String(error);
    // The error detail includes the response body snippet; verify it's bounded.
    expect(Buffer.byteLength(msg, "utf8")).toBeLessThan(32 * 1024);
    expect(msg).toContain("Google Meet spaces.get");
  });

  it("passes valid spaces.get response through", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("meet.googleapis.com")) {
        return await origFetch(`http://127.0.0.1:${port}/spaces%2Fvalid-test`, init);
      }
      return await origFetch(input, init);
    });

    // Override the server handler for this test to return a valid response.
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "spaces/valid-test" }));
    });

    const { fetchGoogleMeetSpace } = await import("./meet.js");
    const result = await fetchGoogleMeetSpace({
      accessToken: "fake-token",
      meeting: "valid-test",
    });

    expect(result.name).toBe("spaces/valid-test");
  });
});
