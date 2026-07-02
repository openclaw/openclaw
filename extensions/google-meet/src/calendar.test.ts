// Google Meet tests cover bounded Calendar API response reads through the real SSRF guard.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { listGoogleMeetCalendarEvents } from "./calendar.js";

type LocalServer = {
  baseUrl: string;
  stop: () => Promise<void>;
};

type DispatcherAwareRequestInit = RequestInit & { dispatcher?: unknown };

type OversizedWriteState = { bytesWritten: number; closed: boolean };

type GoogleMeetCalendarFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type LocalGuardFetchDeps = {
  fetchImpl: GoogleMeetCalendarFetch;
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

function createCalendarFetchDeps(localBaseUrl: string): LocalGuardFetchDeps {
  const realFetch = globalThis.fetch.bind(globalThis);
  return {
    fetchImpl: async (input, init) => {
      const url = new URL(requestUrl(input));
      if (url.hostname !== "www.googleapis.com") {
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

describe("listGoogleMeetCalendarEvents — bounded Calendar API read", () => {
  it("returns events when the Calendar response is within the 16 MiB cap", async () => {
    const eventsPayload = {
      items: [
        {
          id: "event1",
          summary: "Weekly Sync",
          hangoutLink: "https://meet.google.com/abc-def-ghi",
          start: { dateTime: new Date(Date.now() + 60_000).toISOString() },
          end: { dateTime: new Date(Date.now() + 3_660_000).toISOString() },
        },
      ],
    };
    const server = await startLocalServer((_req, res) => {
      writeJson(res, eventsPayload);
    });

    try {
      const fetchDeps = createCalendarFetchDeps(server.baseUrl);
      const result = await listGoogleMeetCalendarEvents({
        accessToken: "tok",
        calendarId: "primary",
        ...fetchDeps,
      });

      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events[0]?.meetingUri).toBe("https://meet.google.com/abc-def-ghi");
    } finally {
      await server.stop();
    }
  });

  it("rejects with a size error when Calendar response body exceeds 16 MiB (fail-closed)", async () => {
    const overCap = 17 * 1024 * 1024;
    const state: OversizedWriteState = { bytesWritten: 0, closed: false };
    const server = await startLocalServer((_req, res) => {
      writeOversizedJson(res, { sizeBytes: overCap, state });
    });

    try {
      const fetchDeps = createCalendarFetchDeps(server.baseUrl);
      await expect(
        listGoogleMeetCalendarEvents({
          accessToken: "tok",
          calendarId: "primary",
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
