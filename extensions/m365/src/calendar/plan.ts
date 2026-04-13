import { createHash } from "node:crypto";
import type {
  CalendarApprovalSnapshot,
  CalendarAttendee,
  CalendarChangePlan,
  CalendarChangeRequest,
  QueuedCalendarChange,
} from "./types.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

const APPROVAL_TITLE_LIMIT = 80;
const APPROVAL_DESCRIPTION_LIMIT = 256;

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTimeZone(value: string | undefined): string {
  return trimOptional(value) ?? "UTC";
}

function normalizeDateTime(
  value: { dateTime: string; timeZone: string } | undefined,
  fieldName: "start" | "end",
) {
  if (!value) {
    return undefined;
  }
  const dateTime = trimOptional(value.dateTime);
  if (!dateTime) {
    throw new Error(`${fieldName}.dateTime required`);
  }
  return {
    dateTime,
    timeZone: normalizeTimeZone(value.timeZone),
  };
}

function normalizeAttendee(attendee: CalendarAttendee): CalendarAttendee {
  const email = attendee.email.trim().toLowerCase();
  return {
    email,
    ...(trimOptional(attendee.name) ? { name: trimOptional(attendee.name) } : {}),
    ...(attendee.type ? { type: attendee.type } : {}),
  };
}

function compareAttendees(left: CalendarAttendee, right: CalendarAttendee): number {
  const emailOrder = left.email.localeCompare(right.email);
  if (emailOrder !== 0) {
    return emailOrder;
  }
  return (left.type ?? "required").localeCompare(right.type ?? "required");
}

function sortedJson(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sortedJson(entry));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right));
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of entries) {
      output[key] = sortedJson(entry);
    }
    return output;
  }
  return null;
}

export function stableCalendarPlanJson(plan: CalendarChangePlan): string {
  return JSON.stringify(sortedJson(plan));
}

export function hashCalendarPlan(plan: CalendarChangePlan): string {
  return `sha256:${createHash("sha256").update(stableCalendarPlanJson(plan)).digest("hex")}`;
}

export function normalizeCalendarChangeRequest(request: CalendarChangeRequest): CalendarChangePlan {
  const calendarUser = request.calendarUser.trim().toLowerCase();
  if (!calendarUser) {
    throw new Error("calendarUser required");
  }
  const eventId = trimOptional(request.eventId);
  if ((request.operation === "update" || request.operation === "cancel") && !eventId) {
    throw new Error("eventId required for update and cancel calendar changes");
  }

  const start = normalizeDateTime(request.start, "start");
  const end = normalizeDateTime(request.end, "end");
  if (request.operation === "create" && (!start || !end)) {
    throw new Error("start and end required for create calendar changes");
  }

  const body = trimOptional(request.body);
  const attendees = (request.attendees ?? [])
    .map(normalizeAttendee)
    .filter((attendee) => attendee.email)
    .toSorted(compareAttendees);

  return {
    version: 1,
    operation: request.operation,
    calendarUser,
    ...(eventId ? { eventId } : {}),
    ...(trimOptional(request.changeKey) ? { changeKey: trimOptional(request.changeKey) } : {}),
    ...(trimOptional(request.subject) ? { subject: trimOptional(request.subject) } : {}),
    ...(body ? { body } : {}),
    ...(body && request.bodyContentType ? { bodyContentType: request.bodyContentType } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(trimOptional(request.location) ? { location: trimOptional(request.location) } : {}),
    ...(typeof request.onlineMeeting === "boolean" ? { onlineMeeting: request.onlineMeeting } : {}),
    attendees,
    ...(trimOptional(request.comment) ? { comment: trimOptional(request.comment) } : {}),
    notifyAttendees: request.notifyAttendees !== false,
    ...(trimOptional(request.idempotencyKey)
      ? { idempotencyKey: trimOptional(request.idempotencyKey) }
      : {}),
  };
}

function truncateForApproval(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatTimeRange(plan: CalendarChangePlan): string | undefined {
  if (!plan.start && !plan.end) {
    return undefined;
  }
  if (plan.start && plan.end) {
    return `${plan.start.dateTime} ${plan.start.timeZone} to ${plan.end.dateTime} ${plan.end.timeZone}`;
  }
  const onlyTime = plan.start ?? plan.end;
  return onlyTime ? `${onlyTime.dateTime} ${onlyTime.timeZone}` : undefined;
}

function approvalTitle(plan: CalendarChangePlan): string {
  if (plan.operation === "create") {
    return plan.attendees.length > 0 ? "Send calendar invite?" : "Create calendar event?";
  }
  if (plan.operation === "update") {
    return "Update calendar event?";
  }
  return "Cancel calendar event?";
}

function approvalDescription(plan: CalendarChangePlan): string {
  const subject = plan.subject ?? "(no subject)";
  const timeRange = formatTimeRange(plan);
  const attendeePart =
    plan.attendees.length === 1 ? "1 attendee" : `${plan.attendees.length} attendees`;
  const eventPart = plan.eventId ? `event ${plan.eventId}` : "new event";
  const parts = [
    subject,
    timeRange,
    attendeePart,
    plan.calendarUser,
    plan.operation === "cancel" ? eventPart : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" | ");
}

export function buildCalendarApprovalSnapshot(plan: CalendarChangePlan): CalendarApprovalSnapshot {
  const planHash = hashCalendarPlan(plan);
  const timeRange = formatTimeRange(plan);
  return {
    kind: "m365.calendar.approval",
    version: 1,
    planHash,
    title: truncateForApproval(approvalTitle(plan), APPROVAL_TITLE_LIMIT),
    description: truncateForApproval(approvalDescription(plan), APPROVAL_DESCRIPTION_LIMIT),
    severity: plan.operation === "create" && plan.attendees.length === 0 ? "info" : "warning",
    summary: {
      operation: plan.operation,
      calendarUser: plan.calendarUser,
      ...(plan.eventId ? { eventId: plan.eventId } : {}),
      ...(plan.changeKey ? { changeKey: plan.changeKey } : {}),
      ...(plan.subject ? { subject: plan.subject } : {}),
      ...(timeRange ? { timeRange } : {}),
      ...(typeof plan.onlineMeeting === "boolean" ? { onlineMeeting: plan.onlineMeeting } : {}),
      attendeeCount: plan.attendees.length,
      attendeeEmails: plan.attendees.map((attendee) => attendee.email),
      notifyAttendees: plan.notifyAttendees,
    },
    plan,
  };
}

export function queueCalendarChange(request: CalendarChangeRequest): QueuedCalendarChange {
  const plan = normalizeCalendarChangeRequest(request);
  const approvalSnapshot = buildCalendarApprovalSnapshot(plan);
  return {
    kind: "m365.calendar.queued_change",
    version: 1,
    planHash: approvalSnapshot.planHash,
    plan,
    approvalSnapshot,
  };
}

export function assertCalendarPlanHash(plan: CalendarChangePlan, expectedHash: string): void {
  const actualHash = hashCalendarPlan(plan);
  if (actualHash !== expectedHash) {
    throw new Error(`calendar plan hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
}
