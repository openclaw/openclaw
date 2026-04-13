import { describe, expect, it } from "vitest";
import { buildCalendarApprovalSnapshot, hashCalendarPlan, queueCalendarChange } from "./plan.js";

describe("M365 calendar change plans", () => {
  it("hashes semantically equivalent attendee orderings the same way", () => {
    const first = queueCalendarChange({
      operation: "create",
      calendarUser: "Ada@Example.com ",
      subject: " Planning ",
      start: { dateTime: "2026-04-14T10:00:00", timeZone: "Pacific Standard Time" },
      end: { dateTime: "2026-04-14T10:30:00", timeZone: "Pacific Standard Time" },
      attendees: [
        { email: "ZED@example.com", type: "optional" },
        { email: "alice@example.com", type: "required" },
      ],
      idempotencyKey: "run-123",
    });
    const second = queueCalendarChange({
      operation: "create",
      calendarUser: "ada@example.com",
      subject: "Planning",
      start: { dateTime: "2026-04-14T10:00:00", timeZone: "Pacific Standard Time" },
      end: { dateTime: "2026-04-14T10:30:00", timeZone: "Pacific Standard Time" },
      attendees: [
        { email: "ALICE@example.com", type: "required" },
        { email: "zed@example.com", type: "optional" },
      ],
      idempotencyKey: "run-123",
    });

    expect(first.planHash).toBe(second.planHash);
    expect(first.plan.attendees.map((attendee) => attendee.email)).toEqual([
      "alice@example.com",
      "zed@example.com",
    ]);
  });

  it("builds approval snapshots with bounded approval text and plan payload", () => {
    const queued = queueCalendarChange({
      operation: "update",
      calendarUser: "owner@example.com",
      eventId: "event-1",
      subject: "A".repeat(280),
      start: { dateTime: "2026-04-14T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-04-14T10:30:00", timeZone: "UTC" },
      attendees: [{ email: "person@example.com" }],
    });
    const snapshot = buildCalendarApprovalSnapshot(queued.plan);

    expect(snapshot.planHash).toBe(hashCalendarPlan(queued.plan));
    expect(snapshot.title.length).toBeLessThanOrEqual(80);
    expect(snapshot.description.length).toBeLessThanOrEqual(256);
    expect(snapshot.summary).toMatchObject({
      operation: "update",
      calendarUser: "owner@example.com",
      eventId: "event-1",
      attendeeCount: 1,
      attendeeEmails: ["person@example.com"],
    });
    expect(snapshot.plan).toEqual(queued.plan);
  });

  it("requires an event id for update and cancel plans", () => {
    expect(() =>
      queueCalendarChange({
        operation: "cancel",
        calendarUser: "owner@example.com",
      }),
    ).toThrow("eventId required");
  });

  it("binds the plan hash to the queued event change key", () => {
    const first = queueCalendarChange({
      operation: "update",
      calendarUser: "owner@example.com",
      eventId: "event-1",
      changeKey: "ck-1",
      subject: "Planning",
    });
    const second = queueCalendarChange({
      operation: "update",
      calendarUser: "owner@example.com",
      eventId: "event-1",
      changeKey: "ck-2",
      subject: "Planning",
    });

    expect(first.plan.changeKey).toBe("ck-1");
    expect(second.plan.changeKey).toBe("ck-2");
    expect(first.planHash).not.toBe(second.planHash);
  });
});
