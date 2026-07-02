// Google Meet tests prove bounded reads through the real SSRF fetch guard.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { listGoogleMeetCalendarEvents } from "./calendar.js";
import { fetchGoogleMeetSpace } from "./meet.js";

type RecordedRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
};

type LocalServer = {
  baseUrl: string;
  requests: RecordedRequest[];
  stop: () => Promise<void>;
};

type GoogleApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type DispatcherAwareRequestInit = RequestInit & { dispatcher?: unknown };

type OversizedWriteState = { bytesWritten: number; closed: boolean };

type LocalGuardFetchDeps = {
  fetchImpl: GoogleApiFetch;
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
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
    });
    handler(req, res);
  });
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
    requests,
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

function createLocalGuardFetchDeps(params: {
  localBaseUrl: string;
  allowedHostnames: string[];
}): LocalGuardFetchDeps {
  const realFetch = globalThis.fetch.bind(globalThis);
  const allowedHostnames = new Set(params.allowedHostnames);
  return {
    fetchImpl: async (input, init) => {
      const url = new URL(requestUrl(input));
      if (!allowedHostnames.has(url.hostname)) {
        return await realFetch(input, init);
      }
      const loopback = new URL(`${url.pathname}${url.search}`, params.localBaseUrl);
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
    totalBytes: number;
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
    if (res.destroyed || sent >= params.totalBytes) {
      if (!res.destroyed) {
        res.end();
      }
      return;
    }
    const size = Math.min(chunk.byteLength, params.totalBytes - sent);
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

describe("Google Meet API bounded reads through the real fetch guard", () => {
  it("lists Calendar events through fetchWithSsrFGuard and parses under-cap JSON", async () => {
    const server = await startLocalServer((_req, res) => {
      writeJson(res, {
        items: [
          {
            id: "event-real-guard",
            summary: "Real guard proof",
            hangoutLink: "https://meet.google.com/abc-def-ghi",
            start: { dateTime: new Date(Date.now() + 60_000).toISOString() },
            end: { dateTime: new Date(Date.now() + 3_660_000).toISOString() },
          },
        ],
      });
    });

    try {
      const fetchDeps = createLocalGuardFetchDeps({
        localBaseUrl: server.baseUrl,
        allowedHostnames: ["www.googleapis.com"],
      });
      const result = await listGoogleMeetCalendarEvents({
        accessToken: "tok-calendar",
        calendarId: "primary",
        ...fetchDeps,
      });

      expect(server.requests).toHaveLength(1);
      const request = server.requests[0];
      expect(request?.method).toBe("GET");
      expect(request?.url).toMatch(/^\/calendar\/v3\/calendars\/primary\/events\?/);
      expect(request?.headers.authorization).toBe("Bearer tok-calendar");
      expect(request?.headers.accept).toBe("application/json");
      expect(result.events[0]?.meetingUri).toBe("https://meet.google.com/abc-def-ghi");
      console.log(
        `[google-meet fetch-guard proof] calendar events via real fetch guard: count=${result.events.length}`,
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects oversized Meet space JSON through fetchWithSsrFGuard before full buffering", async () => {
    const overCap = 17 * 1024 * 1024;
    const state: OversizedWriteState = { bytesWritten: 0, closed: false };
    const server = await startLocalServer((_req, res) => {
      writeOversizedJson(res, { totalBytes: overCap, state });
    });

    try {
      const fetchDeps = createLocalGuardFetchDeps({
        localBaseUrl: server.baseUrl,
        allowedHostnames: ["meet.googleapis.com"],
      });
      await expect(
        fetchGoogleMeetSpace({
          accessToken: "tok-meet",
          meeting: "spaces/abc123",
          ...fetchDeps,
        }),
      ).rejects.toThrow(/google-meet\.spaces\.get: JSON response exceeds \d+ bytes/);

      expect(server.requests).toHaveLength(1);
      const request = server.requests[0];
      expect(request?.method).toBe("GET");
      expect(request?.url).toBe("/v2/spaces/abc123");
      expect(request?.headers.authorization).toBe("Bearer tok-meet");
      await waitForServerClose(state);
      expect(state.closed).toBe(true);
      expect(state.bytesWritten).toBeLessThan(overCap);
      console.log(
        `[google-meet fetch-guard proof] Meet spaces oversized JSON canceled at ${state.bytesWritten}/${overCap} bytes`,
      );
    } finally {
      await server.stop();
    }
  });
});

describe("google-meet bound reads with a real HTTP server through the SSRF guard", () => {
  it("rejects oversized response before fully buffering 20 MiB (OOM guard)", async () => {
    const totalBytes = 20 * 1024 * 1024;
    const state: OversizedWriteState = { bytesWritten: 0, closed: false };
    const server = await startLocalServer((_req, res) => {
      writeOversizedJson(res, { totalBytes, state });
    });

    try {
      const fetchDeps = createLocalGuardFetchDeps({
        localBaseUrl: server.baseUrl,
        allowedHostnames: ["meet.googleapis.com"],
      });
      await expect(
        fetchGoogleMeetSpace({
          accessToken: "tok-meet",
          meeting: "spaces/abc123",
          ...fetchDeps,
        }),
      ).rejects.toThrow(/JSON response exceeds/);

      expect(server.requests).toHaveLength(1);
      await waitForServerClose(state);
      expect(state.closed).toBe(true);
      expect(state.bytesWritten).toBeLessThan(totalBytes);
      console.log(`[bound-proof] canceled at ${state.bytesWritten}/${totalBytes} bytes`);
    } finally {
      await server.stop();
    }
  });

  it("parses well-formed JSON response under the 16 MiB cap", async () => {
    const server = await startLocalServer((_req, res) => {
      writeJson(res, { kind: "calendar#events", items: [] });
    });

    try {
      const fetchDeps = createLocalGuardFetchDeps({
        localBaseUrl: server.baseUrl,
        allowedHostnames: ["www.googleapis.com"],
      });
      const result = await listGoogleMeetCalendarEvents({
        accessToken: "tok-calendar",
        calendarId: "primary",
        ...fetchDeps,
      });

      expect(server.requests).toHaveLength(1);
      expect(result).toEqual({ calendarId: "primary", events: [] });
    } finally {
      await server.stop();
    }
  });
});
