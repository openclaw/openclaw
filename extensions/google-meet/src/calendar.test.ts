// Google Meet tests cover Calendar API request behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listGoogleMeetCalendarEvents } from "./calendar.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const meetingUri = "https://meet.google.com/abc-defg-hij";

async function resolveCalendarMeetingUri(event: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: [event] })),
  );
  const result = await listGoogleMeetCalendarEvents({
    accessToken: "test-token",
  });
  return result.events[0]?.meetingUri;
}

describe("Google Meet calendar URL extraction", () => {
  it.each([
    [{ hangoutLink: "http://meet.google.com/abc-defg-hij" }, meetingUri],
    ...[
      "https://example.com/abc-defg-hij",
      "https://meet.google.com/not-a-code",
      "https://meet.google.com/lookup/classroom-alias",
      "https://user@meet.google.com/abc-defg-hij",
      "https://meet.google.com:444/abc-defg-hij",
    ].map((hangoutLink) => [{ hangoutLink }, undefined] as const),
    [{ hangoutLink: `${meetingUri}?authuser=0` }, `${meetingUri}?authuser=0`],
    [
      {
        conferenceData: {
          entryPoints: [
            { entryPointType: "video", uri: "https://example.com/abc-defg-hij" },
            { entryPointType: "video", uri: "http://meet.google.com/abc-defg-hij" },
          ],
        },
      },
      meetingUri,
    ],
    [{ location: `Old https://meet.google.com/not-a-code, join ${meetingUri}` }, meetingUri],
    [{ location: "Join https://meet.google.com/not-a-code" }, undefined],
    [{ description: `Join ${meetingUri}` }, meetingUri],
  ] as const)("applies the Meet URL contract to %j", async (event, expected) => {
    await expect(resolveCalendarMeetingUri(event)).resolves.toBe(expected);
  });

  it("includes later events after an empty page without changing query filters", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ items: [], nextPageToken: "second" }))
      .mockResolvedValueOnce(Response.json({ items: [], nextPageToken: "third" }))
      .mockResolvedValueOnce(
        Response.json({
          items: [{ id: "target", hangoutLink: meetingUri }],
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await listGoogleMeetCalendarEvents({
      accessToken: "test-token",
      eventQuery: "target",
    });
    expect(result.events).toMatchObject([{ event: { id: "target" }, selected: true }]);
    const urls = fetch.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : url));
    expect(urls.map((url) => url.searchParams.get("pageToken"))).toEqual([null, "second", "third"]);
    for (const url of urls) {
      url.searchParams.delete("pageToken");
      expect(url.toString()).toBe(urls[0]?.toString());
    }
  });
});
