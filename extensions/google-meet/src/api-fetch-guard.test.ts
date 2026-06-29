// Google Meet tests prove bounded reads through the real SSRF fetch guard.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { listGoogleMeetCalendarEvents } from "./calendar.js";
import { fetchGoogleMeetSpace } from "./meet.js";

function streamedJsonResponse(payload: unknown): Response {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const midpoint = Math.floor(encoded.length / 2);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, midpoint));
        controller.enqueue(encoded.slice(midpoint));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function oversizedJsonResponse(totalBytes: number): {
  response: Response;
  state: { bytesPulled: number; canceled: boolean };
} {
  const chunk = new Uint8Array(64 * 1024).fill(0x78);
  const state = { bytesPulled: 0, canceled: false };
  let sent = 0;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= totalBytes) {
            controller.close();
            return;
          }
          const size = Math.min(chunk.byteLength, totalBytes - sent);
          sent += size;
          state.bytesPulled += size;
          controller.enqueue(chunk.subarray(0, size));
        },
        cancel() {
          state.canceled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    state,
  };
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
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

describe("Google Meet API bounded reads through the real fetch guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists Calendar events through fetchWithSsrFGuard and parses under-cap JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      expect(url).toMatch(
        /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/,
      );
      expect(requestHeader(init, "authorization")).toBe("Bearer tok-calendar");
      expect(requestHeader(init, "accept")).toBe("application/json");
      return streamedJsonResponse({
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

    const result = await listGoogleMeetCalendarEvents({
      accessToken: "tok-calendar",
      calendarId: "primary",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.events[0]?.meetingUri).toBe("https://meet.google.com/abc-def-ghi");
    console.log(
      `[google-meet fetch-guard proof] calendar events via real fetch guard: count=${result.events.length}`,
    );
  });

  it("rejects oversized Meet space JSON through fetchWithSsrFGuard before full buffering", async () => {
    const overCap = 17 * 1024 * 1024;
    const { response, state } = oversizedJsonResponse(overCap);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(requestUrl(input)).toBe("https://meet.googleapis.com/v2/spaces/abc123");
      expect(requestHeader(init, "authorization")).toBe("Bearer tok-meet");
      return response;
    });

    await expect(
      fetchGoogleMeetSpace({ accessToken: "tok-meet", meeting: "spaces/abc123" }),
    ).rejects.toThrow(/google-meet\.spaces\.get: JSON response exceeds \d+ bytes/);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(state.canceled).toBe(true);
    expect(state.bytesPulled).toBeLessThan(overCap);
    console.log(
      `[google-meet fetch-guard proof] Meet spaces oversized JSON canceled at ${state.bytesPulled}/${overCap} bytes`,
    );
  });
});

describe("google-meet bound reads — real HTTP server (no fetch mock)", () => {
  it("rejects oversized response before fully buffering 20 MiB (OOM guard)", async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB, all 'a'
    const TOTAL_CHUNKS = 20; // 20 MiB total, well above 16 MiB cap
    let chunksWritten = 0;

    const srv = await new Promise<{ port: number; stop: () => Promise<void> }>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        let sent = 0;
        const sendChunk = () => {
          if (sent >= TOTAL_CHUNKS) {
            res.end();
            return;
          }
          sent++;
          chunksWritten++;
          const ok = res.write(CHUNK);
          if (ok) setImmediate(sendChunk);
          else res.once("drain", sendChunk);
        };
        sendChunk();
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({
          port: addr.port,
          stop: () => new Promise<void>((r, e) => server.close(err => (err ? e(err) : r()))),
        });
      });
    });

    try {
      const response = await fetch(`http://127.0.0.1:${srv.port}/`);
      // Mutation-control: bare `response.json()` would buffer all 20 MiB before throwing.
      // readProviderJsonResponse aborts the stream at 16 MiB.
      await expect(
        readProviderJsonResponse(response, "google-meet.bound-proof"),
      ).rejects.toThrow(/JSON response exceeds/);
      // Proves the body was NOT fully consumed before the cap fired.
      expect(chunksWritten).toBeLessThan(TOTAL_CHUNKS);
      console.log(`[bound-proof] canceled at ${chunksWritten}/${TOTAL_CHUNKS} chunks`);
    } finally {
      await srv.stop();
    }
  });

  it("parses well-formed JSON response under the 16 MiB cap", async () => {
    const payload = { kind: "calendar#events", items: [] };
    const srv = await new Promise<{ port: number; stop: () => Promise<void> }>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({
          port: addr.port,
          stop: () => new Promise<void>((r, e) => server.close(err => (err ? e(err) : r()))),
        });
      });
    });
    try {
      const response = await fetch(`http://127.0.0.1:${srv.port}/`);
      const result = await readProviderJsonResponse<typeof payload>(
        response,
        "google-meet.bound-proof",
      );
      expect(result).toEqual(payload);
    } finally {
      await srv.stop();
    }
  });
});
