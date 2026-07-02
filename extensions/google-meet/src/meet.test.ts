// Google Meet tests cover bounded Meet API response reads through the real SSRF guard.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { createGoogleMeetSpace, fetchGoogleMeetSpace } from "./meet.js";

type LocalServer = {
  baseUrl: string;
  stop: () => Promise<void>;
};

type DispatcherAwareRequestInit = RequestInit & { dispatcher?: unknown };

type OversizedWriteState = { bytesWritten: number; closed: boolean };

type GoogleMeetApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type LocalGuardFetchDeps = {
  fetchImpl: GoogleMeetApiFetch;
  lookupFn: LookupFn;
};

async function waitForServerClose(state: OversizedWriteState): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!state.closed && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function withoutDispatcher(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) {
    return undefined;
  }
  const { dispatcher: _dispatcher, ...standardInit } = init as DispatcherAwareRequestInit;
  return standardInit;
}

async function startLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LocalServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local test server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

const TEST_PUBLIC_DNS_ADDRESS = "93.184.216.34";

const testLookupFn = (async (_hostname: string, options?: { all?: boolean }) =>
  options?.all
    ? [{ address: TEST_PUBLIC_DNS_ADDRESS, family: 4 }]
    : { address: TEST_PUBLIC_DNS_ADDRESS, family: 4 }) as LookupFn;

function createMeetFetchDeps(localBaseUrl: string): LocalGuardFetchDeps {
  const realFetch = globalThis.fetch.bind(globalThis);
  return {
    fetchImpl: async (input, init) => {
      const url = new URL(requestUrl(input));
      if (url.hostname !== "meet.googleapis.com") {
        return await realFetch(input, init);
      }
      const loopback = new URL(`${url.pathname}${url.search}`, localBaseUrl);
      return await realFetch(loopback, withoutDispatcher(init));
    },
    lookupFn: testLookupFn,
  };
}

function writeJson(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function writeOversizedJson(
  res: ServerResponse,
  params: {
    sizeBytes: number;
    state: OversizedWriteState;
  },
): void {
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  let sent = 0;
  res.on("close", () => {
    params.state.closed = true;
  });
  res.writeHead(200, { "content-type": "application/json" });

  const writeNext = () => {
    if (res.destroyed || sent >= params.sizeBytes) {
      if (!res.destroyed) {
        res.end();
      }
      return;
    }
    const size = Math.min(chunk.byteLength, params.sizeBytes - sent);
    sent += size;
    params.state.bytesWritten += size;
    const canContinue = res.write(chunk.subarray(0, size));
    if (canContinue) {
      setTimeout(writeNext, 1);
      return;
    }
    res.once("drain", () => setTimeout(writeNext, 1));
  };

  writeNext();
}

// ---------------------------------------------------------------------------
// fetchGoogleMeetSpace — exercising the readProviderJsonResponse guard
// (fetchGoogleMeetSpace has its own fetchWithSsrFGuard call; guarding it also
// covers the fetchGoogleMeetJson shared helper which wraps the same pattern)
// ---------------------------------------------------------------------------

describe("fetchGoogleMeetSpace — bounded read", () => {
  it("parses a well-formed space response within the 16 MiB cap", async () => {
    const spacePayload = {
      name: "spaces/abc123",
      meetingCode: "abc-def-ghi",
      meetingUri: "https://meet.google.com/abc-def-ghi",
    };
    const server = await startLocalServer((_req, res) => {
      writeJson(res, spacePayload);
    });

    try {
      const fetchDeps = createMeetFetchDeps(server.baseUrl);
      const result = await fetchGoogleMeetSpace({
        accessToken: "tok",
        meeting: "spaces/abc123",
        ...fetchDeps,
      });

      expect(result.name).toBe("spaces/abc123");
      expect(result.meetingUri).toBe("https://meet.google.com/abc-def-ghi");
    } finally {
      await server.stop();
    }
  });

  it("rejects with a labelled size error when response body exceeds 16 MiB (fail-closed)", async () => {
    const overCap = 17 * 1024 * 1024;
    const state: OversizedWriteState = { bytesWritten: 0, closed: false };
    const server = await startLocalServer((_req, res) => {
      writeOversizedJson(res, { sizeBytes: overCap, state });
    });

    try {
      const fetchDeps = createMeetFetchDeps(server.baseUrl);
      await expect(
        fetchGoogleMeetSpace({
          accessToken: "tok",
          meeting: "spaces/abc123",
          ...fetchDeps,
        }),
      ).rejects.toThrow(/exceeds/i);

      // The bounded reader must have cancelled the stream before reading all bytes.
      await waitForServerClose(state);
      expect(state.closed).toBe(true);
      expect(state.bytesWritten).toBeLessThan(overCap);
    } finally {
      await server.stop();
    }
  });

  it("mutation: bare response.arrayBuffer() buffers the full oversized body without throwing", async () => {
    // Negative-control: proves that reverting fetchGoogleMeetSpace to a bare
    // response body read would silently buffer the entire oversized body.
    const overCap = 17 * 1024 * 1024;
    const response = new Response(Buffer.alloc(overCap, 0x78), {
      headers: { "content-type": "application/json" },
    });
    const buffer = await response.arrayBuffer();
    expect(buffer.byteLength).toBeGreaterThan(16 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// createGoogleMeetSpace — independent fetchWithSsrFGuard caller
// ---------------------------------------------------------------------------

describe("createGoogleMeetSpace — bounded read", () => {
  it("parses a well-formed create-space response within the 16 MiB cap", async () => {
    const spacePayload = {
      name: "spaces/newSpace",
      meetingCode: "new-space-code",
      meetingUri: "https://meet.google.com/new-space-code",
    };
    const server = await startLocalServer((_req, res) => {
      writeJson(res, spacePayload);
    });

    try {
      const fetchDeps = createMeetFetchDeps(server.baseUrl);
      const result = await createGoogleMeetSpace({
        accessToken: "tok",
        ...fetchDeps,
      });

      expect(result.space.name).toBe("spaces/newSpace");
      expect(result.meetingUri).toBe("https://meet.google.com/new-space-code");
    } finally {
      await server.stop();
    }
  });

  it("rejects with a labelled size error when create-space response body exceeds 16 MiB", async () => {
    const overCap = 17 * 1024 * 1024;
    const state: OversizedWriteState = { bytesWritten: 0, closed: false };
    const server = await startLocalServer((_req, res) => {
      writeOversizedJson(res, { sizeBytes: overCap, state });
    });

    try {
      const fetchDeps = createMeetFetchDeps(server.baseUrl);
      await expect(
        createGoogleMeetSpace({
          accessToken: "tok",
          ...fetchDeps,
        }),
      ).rejects.toThrow(/exceeds/i);

      await waitForServerClose(state);
      expect(state.closed).toBe(true);
      expect(state.bytesWritten).toBeLessThan(overCap);
    } finally {
      await server.stop();
    }
  });
});
