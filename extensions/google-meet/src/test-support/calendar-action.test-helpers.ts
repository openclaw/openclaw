import { expect, it, vi } from "vitest";
import { MEET_URL, stubMeetArtifactsApi } from "./fixtures.test-helpers.js";
import type { getMeetTool } from "./plugin-harness.js";

export function registerCalendarActionTests(createTool: () => ReturnType<typeof getMeetTool>) {
  it.each(["latest", "calendar_events"] as const)(
    "reports today's Meet calendar data through %s",
    async (action) => {
      stubMeetArtifactsApi();
      const tool = createTool();
      const request = { accessToken: "token", expiresAt: Date.now() + 120_000, today: true };
      if (action === "latest") {
        const result = await tool.execute("id", { action, ...request });
        expect(result.details.calendarEvent?.meetingUri).toBe(MEET_URL);
      } else {
        const result = await tool.execute("id", { action, ...request });
        expect(result.details.events).toHaveLength(1);
        expect(result.details.events?.[0]?.selected).toBe(true);
        expect(result.details.events?.[0]?.meetingUri).toBe(MEET_URL);
      }
    },
  );

  it("ends today's Calendar lookup at the next local midnight after a skipped midnight", async () => {
    vi.stubEnv("TZ", "America/Santiago");
    vi.useFakeTimers({ toFake: ["Date"] });
    const windows: Array<Array<string | null>> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const query = new URL(url).searchParams;
      windows.push([query.get("timeMin"), query.get("timeMax")]);
      return Response.json({ items: [] });
    });
    const tool = createTool();
    for (const noon of ["2025-09-07T15:00:00Z", "2025-09-08T15:00:00Z"]) {
      vi.setSystemTime(new Date(noon));
      await tool.execute("id", {
        action: "calendar_events",
        accessToken: "token",
        expiresAt: Date.now() + 120_000,
        today: true,
      });
    }
    expect(windows).toEqual([
      ["2025-09-07T04:00:00.000Z", "2025-09-08T03:00:00.000Z"],
      ["2025-09-08T03:00:00.000Z", "2025-09-09T03:00:00.000Z"],
    ]);
  });
}
