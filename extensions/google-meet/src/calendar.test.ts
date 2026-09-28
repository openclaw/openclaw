// Google Meet tests cover Calendar API request behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listGoogleMeetCalendarEvents } from "./calendar.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function resolveCalendarMeetingUri(event: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [event] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  const result = await listGoogleMeetCalendarEvents({
    accessToken: "test-token",
    now: new Date("2026-04-25T09:50:00Z"),
  });
  return result.events[0]?.meetingUri;
}

describe("Google Meet calendar URL extraction", () => {
  it("normalizes Calendar HTTP links before applying the runtime Meet URL contract", async () => {
    for (const [hangoutLink, expected] of [
      ["http://meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij"],
      ["https://example.com/abc-defg-hij", undefined],
      ["https://meet.google.com/not-a-code", undefined],
      ["https://meet.google.com/lookup/classroom-alias", undefined],
      ["https://user@meet.google.com/abc-defg-hij", undefined],
      ["https://meet.google.com:444/abc-defg-hij", undefined],
      [
        "https://meet.google.com/abc-defg-hij?authuser=0",
        "https://meet.google.com/abc-defg-hij?authuser=0",
      ],
    ]) {
      await expect(resolveCalendarMeetingUri({ hangoutLink })).resolves.toBe(expected);
    }
  });

  it("ignores malformed conference entrypoints before selecting and upgrading a valid one", async () => {
    await expect(
      resolveCalendarMeetingUri({
        conferenceData: {
          entryPoints: [
            {
              entryPointType: "video",
              uri: "https://example.com/abc-defg-hij",
            },
            {
              entryPointType: "video",
              uri: "http://meet.google.com/abc-defg-hij",
            },
          ],
        },
      }),
    ).resolves.toBe("https://meet.google.com/abc-defg-hij");
  });

  it("applies the Meet URL contract to calendar text fallbacks", async () => {
    await expect(
      resolveCalendarMeetingUri({
        location:
          "Old https://meet.google.com/not-a-code, join https://meet.google.com/abc-defg-hij",
      }),
    ).resolves.toBe("https://meet.google.com/abc-defg-hij");
    await expect(
      resolveCalendarMeetingUri({
        location: "Join https://meet.google.com/not-a-code",
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveCalendarMeetingUri({
        description: "Join https://meet.google.com/abc-defg-hij",
      }),
    ).resolves.toBe("https://meet.google.com/abc-defg-hij");
  });
});
