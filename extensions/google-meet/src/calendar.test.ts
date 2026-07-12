// Google Meet tests cover Calendar API request behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGoogleMeetUriFromCalendarEvent, listGoogleMeetCalendarEvents } from "./calendar.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Google Calendar requests", () => {
  it("aborts a stalled events.list request after 30 seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected Calendar request abort signal"));
          return;
        }
        const rejectAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Calendar request was aborted"),
          );
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = listGoogleMeetCalendarEvents({ accessToken: "test-token" });
    const rejection = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await rejection;
  });
});

describe("Google Meet calendar URL extraction", () => {
  it("requires hangout links to match the runtime Meet URL contract", () => {
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "http://meet.google.com/abc-defg-hij",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://meet.google.com/not-a-code",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://meet.google.com/lookup/classroom-alias",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://meet.google.com/abc-defg-hij?authuser=0",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij?authuser=0");
  });

  it("ignores malformed conference entrypoints before selecting a valid one", () => {
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        conferenceData: {
          entryPoints: [
            {
              entryPointType: "video",
              uri: "http://meet.google.com/abc-defg-hij",
            },
            {
              entryPointType: "video",
              uri: "https://meet.google.com/abc-defg-hij",
            },
          ],
        },
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("filters Meet-like links in calendar text through the same URL contract", () => {
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        location: "Join https://meet.google.com/not-a-code",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        location: "Join https://meet.google.com/abc-defg-hijk",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        location: "Join https://meet.google.com/abc-defg-hij-notes",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        description: "Join https://meet.google.com/abc-defg-hij.",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        description: "Join https://meet.google.com/abc-defg-hij?authuser=0.",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij?authuser=0");
  });
});
