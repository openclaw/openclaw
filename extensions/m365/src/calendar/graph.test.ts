import { describe, expect, it, vi } from "vitest";
import {
  cancelCalendarEvent,
  createCalendarEvent,
  executeQueuedCalendarChange,
  findCalendarFreeBusy,
  getCalendarEvent,
  listCalendarAgenda,
  type M365GraphClient,
  type M365GraphRequest,
} from "./graph.js";
import { queueCalendarChange } from "./plan.js";

function createGraphClient(response: unknown) {
  const requests: M365GraphRequest[] = [];
  const client: M365GraphClient = {
    requestJson: vi.fn(async (path, options) => {
      requests.push({
        method: (options?.method as M365GraphRequest["method"] | undefined) ?? "GET",
        path,
        ...(options?.query ? { query: options.query as M365GraphRequest["query"] } : {}),
        ...(options?.body !== undefined ? { body: options.body } : {}),
      });
      return response;
    }),
  };
  return { client, requests };
}

describe("M365 calendar Graph helpers", () => {
  it("builds calendarView requests and normalizes agenda events", async () => {
    const { client, requests } = createGraphClient({
      value: [
        {
          id: "event-1",
          subject: "Planning",
          start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
          location: { displayName: "Room 1" },
          attendees: [{ emailAddress: { address: "ALICE@example.com" } }],
          webLink: "https://graph.example/event-1",
        },
      ],
    });

    const result = await listCalendarAgenda(client, {
      calendarUser: "Owner@Example.com",
      start: "2026-04-14T00:00:00",
      end: "2026-04-15T00:00:00",
      top: 10,
    });

    expect(requests[0]).toEqual({
      method: "GET",
      path: "/users/owner%40example.com/calendarView",
      query: {
        $orderby: "start/dateTime",
        $top: "10",
        endDateTime: "2026-04-15T00:00:00",
        startDateTime: "2026-04-14T00:00:00",
      },
    });
    expect(result.events).toEqual([
      {
        id: "event-1",
        subject: "Planning",
        start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
        location: "Room 1",
        attendeeEmails: ["alice@example.com"],
        webLink: "https://graph.example/event-1",
      },
    ]);
  });

  it("builds getSchedule requests for free-busy lookups", async () => {
    const { client, requests } = createGraphClient({
      value: [
        {
          scheduleId: "Alice@Example.com",
          availabilityView: "02",
          scheduleItems: [
            {
              status: "busy",
              start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
            },
          ],
        },
      ],
    });

    const result = await findCalendarFreeBusy(client, {
      calendarUser: "owner@example.com",
      schedules: ["Alice@Example.com"],
      start: "2026-04-14T09:00:00",
      end: "2026-04-14T12:00:00",
      timeZone: "UTC",
      intervalMinutes: 15,
    });

    expect(requests[0]).toEqual({
      method: "POST",
      path: "/users/owner%40example.com/calendar/getSchedule",
      body: {
        schedules: ["alice@example.com"],
        startTime: { dateTime: "2026-04-14T09:00:00", timeZone: "UTC" },
        endTime: { dateTime: "2026-04-14T12:00:00", timeZone: "UTC" },
        availabilityViewInterval: 15,
      },
    });
    expect(result.schedules[0]).toEqual({
      scheduleId: "alice@example.com",
      availabilityView: "02",
      items: [
        {
          status: "busy",
          start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
        },
      ],
    });
  });

  it("reads an existing event and preserves its change key", async () => {
    const { client, requests } = createGraphClient({
      id: "event-1",
      changeKey: "ck-1",
      subject: "Planning",
      start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
    });

    const result = await getCalendarEvent(client, {
      calendarUser: "Owner@Example.com",
      eventId: "event/1",
    });

    expect(requests[0]).toEqual({
      method: "GET",
      path: "/users/owner%40example.com/events/event%2F1",
    });
    expect(result).toMatchObject({
      id: "event-1",
      changeKey: "ck-1",
      subject: "Planning",
    });
  });

  it("validates plan hashes before creating calendar events", async () => {
    const queued = queueCalendarChange({
      operation: "create",
      calendarUser: "owner@example.com",
      subject: "Planning",
      body: "Bring notes",
      start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
      attendees: [{ email: "alice@example.com" }],
      idempotencyKey: "run-123",
    });
    const { client, requests } = createGraphClient({
      id: "event-1",
      subject: "Planning",
      attendees: [{ emailAddress: { address: "alice@example.com" } }],
    });

    await expect(createCalendarEvent(client, queued.plan, "sha256:bad")).rejects.toThrow(
      "calendar plan hash mismatch",
    );
    expect(requests).toEqual([]);

    const result = await executeQueuedCalendarChange(client, queued.plan, queued.planHash);
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/users/owner%40example.com/events",
      body: {
        subject: "Planning",
        body: { contentType: "Text", content: "Bring notes" },
        start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
        attendees: [
          {
            emailAddress: { address: "alice@example.com" },
            type: "required",
          },
        ],
        transactionId: "run-123",
      },
    });
    expect(result.event?.id).toBe("event-1");
  });

  it("cancels events through the Graph cancel action", async () => {
    const queued = queueCalendarChange({
      operation: "cancel",
      calendarUser: "owner@example.com",
      eventId: "event/1",
      comment: "No longer needed",
    });
    const { client, requests } = createGraphClient({});

    const result = await cancelCalendarEvent(client, queued.plan, queued.planHash);

    expect(requests[0]).toEqual({
      method: "POST",
      path: "/users/owner%40example.com/events/event%2F1/cancel",
      body: { comment: "No longer needed" },
    });
    expect(result).toMatchObject({ cancelled: true, planHash: queued.planHash });
  });
});
