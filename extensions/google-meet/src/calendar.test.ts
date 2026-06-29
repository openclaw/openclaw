// Google Meet tests cover bounded Calendar API response reads (listGoogleMeetCalendarEvents).
//
// readProviderJsonResponse is NOT mocked — it runs from real source so the byte-bounded
// reader actually enforces the 16 MiB cap. Only fetchWithSsrFGuard is mocked so tests
// can inject controlled Response bodies without network I/O.
import { describe, expect, it, vi } from "vitest";
import { listGoogleMeetCalendarEvents } from "./calendar.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const mockFetch = vi.mocked(fetchWithSsrFGuard);

function streamedJsonResponse(payload: unknown, status = 200): Response {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeOversizedJsonResponse(sizeBytes: number): {
  response: Response;
  state: { bytesPulled: number; canceled: boolean };
} {
  const CHUNK = 65536;
  const chunk = new Uint8Array(CHUNK).fill(0x78);
  const state = { bytesPulled: 0, canceled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= sizeBytes) {
        controller.close();
        return;
      }
      const toSend = Math.min(CHUNK, sizeBytes - sent);
      controller.enqueue(chunk.subarray(0, toSend));
      sent += toSend;
      state.bytesPulled += toSend;
    },
    cancel() {
      state.canceled = true;
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return { response, state };
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
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({
      response: streamedJsonResponse(eventsPayload),
      finalUrl:
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      release,
    });

    const result = await listGoogleMeetCalendarEvents({
      accessToken: "tok",
      calendarId: "primary",
    });

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]?.meetingUri).toBe("https://meet.google.com/abc-def-ghi");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects with a size error when Calendar response body exceeds 16 MiB (fail-closed)", async () => {
    const OVER_CAP = 17 * 1024 * 1024;
    const { response, state } = makeOversizedJsonResponse(OVER_CAP);
    const release = vi.fn(async () => undefined);
    mockFetch.mockResolvedValueOnce({
      response,
      finalUrl:
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      release,
    });

    await expect(
      listGoogleMeetCalendarEvents({ accessToken: "tok", calendarId: "primary" }),
    ).rejects.toThrow(/exceeds/i);

    expect(state.canceled).toBe(true);
    expect(state.bytesPulled).toBeLessThan(OVER_CAP);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
