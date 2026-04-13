import type { M365GraphJsonClient, M365GraphRequestOptions } from "../graph-client.js";
import { assertCalendarPlanHash } from "./plan.js";
import type {
  CalendarAgendaResult,
  CalendarAttendee,
  CalendarAvailabilitySchedule,
  CalendarChangePlan,
  CalendarEvent,
  CalendarFreeBusyResult,
  CalendarWriteResult,
} from "./types.js";

export type M365GraphRequest = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type M365GraphClient = {
  requestJson: M365GraphJsonClient["requestJson"];
};

export type CalendarAgendaParams = {
  calendarUser: string;
  start: string;
  end: string;
  top?: number;
};

export type CalendarFreeBusyParams = {
  calendarUser: string;
  schedules: string[];
  start: string;
  end: string;
  timeZone: string;
  intervalMinutes?: number;
};

export type CalendarEventLookupParams = {
  calendarUser: string;
  eventId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function calendarUserPath(calendarUser: string): string {
  const normalized = calendarUser.trim();
  if (!normalized) {
    throw new Error("calendarUser required");
  }
  return `/users/${encodePathSegment(normalized)}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDateTime(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const dateTime = readString(value.dateTime);
  const timeZone = readString(value.timeZone);
  if (!dateTime || !timeZone) {
    return undefined;
  }
  return { dateTime, timeZone };
}

function parseAttendeeEmails(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!isRecord(entry) || !isRecord(entry.emailAddress)) {
        return undefined;
      }
      return readString(entry.emailAddress.address)?.toLowerCase();
    })
    .filter((entry): entry is string => Boolean(entry));
}

function parseCalendarEvent(value: unknown): CalendarEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  if (!id) {
    return undefined;
  }
  const changeKey = readString(value.changeKey);
  const location = isRecord(value.location) ? readString(value.location.displayName) : undefined;
  const organizerEmail =
    isRecord(value.organizer) && isRecord(value.organizer.emailAddress)
      ? readString(value.organizer.emailAddress.address)?.toLowerCase()
      : undefined;
  return {
    id,
    ...(changeKey ? { changeKey } : {}),
    ...(readString(value.subject) ? { subject: readString(value.subject) } : {}),
    ...(readDateTime(value.start) ? { start: readDateTime(value.start) } : {}),
    ...(readDateTime(value.end) ? { end: readDateTime(value.end) } : {}),
    ...(location ? { location } : {}),
    ...(organizerEmail ? { organizerEmail } : {}),
    attendeeEmails: parseAttendeeEmails(value.attendees),
    ...(readString(value.webLink) ? { webLink: readString(value.webLink) } : {}),
    ...(typeof value.isCancelled === "boolean" ? { isCancelled: value.isCancelled } : {}),
  };
}

function parseCalendarEventList(value: unknown): CalendarEvent[] {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    return [];
  }
  return value.value
    .map((entry) => parseCalendarEvent(entry))
    .filter((entry): entry is CalendarEvent => Boolean(entry));
}

function parseScheduleItem(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = readDateTime(value.start);
  const end = readDateTime(value.end);
  const status = readString(value.status);
  if (!start || !end || !status) {
    return undefined;
  }
  return { start, end, status };
}

function parseAvailabilitySchedule(value: unknown): CalendarAvailabilitySchedule | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const scheduleId = readString(value.scheduleId);
  if (!scheduleId) {
    return undefined;
  }
  const items = Array.isArray(value.scheduleItems)
    ? value.scheduleItems
        .map((entry) => parseScheduleItem(entry))
        .filter((entry): entry is NonNullable<ReturnType<typeof parseScheduleItem>> =>
          Boolean(entry),
        )
    : [];
  return {
    scheduleId: scheduleId.toLowerCase(),
    ...(readString(value.availabilityView)
      ? { availabilityView: readString(value.availabilityView) }
      : {}),
    items,
  };
}

function parseAvailabilitySchedules(value: unknown): CalendarAvailabilitySchedule[] {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    return [];
  }
  return value.value
    .map((entry) => parseAvailabilitySchedule(entry))
    .filter((entry): entry is CalendarAvailabilitySchedule => Boolean(entry));
}

function buildQuery(query: M365GraphRequest["query"]): Record<string, string> | undefined {
  if (!query) {
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(query).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value !== undefined) {
      output[key] = String(value);
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

async function requestGraph(client: M365GraphClient, request: M365GraphRequest): Promise<unknown> {
  return await client.requestJson(request.path, {
    method: request.method,
    ...(request.query ? { query: buildQuery(request.query) } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
  } satisfies M365GraphRequestOptions);
}

function graphEventBody(plan: CalendarChangePlan): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (plan.subject) {
    body.subject = plan.subject;
  }
  if (plan.body) {
    body.body = {
      contentType: plan.bodyContentType === "html" ? "HTML" : "Text",
      content: plan.body,
    };
  }
  if (plan.start) {
    body.start = plan.start;
  }
  if (plan.end) {
    body.end = plan.end;
  }
  if (plan.location) {
    body.location = { displayName: plan.location };
  }
  if (plan.onlineMeeting) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = "teamsForBusiness";
  }
  if (plan.attendees.length > 0) {
    body.attendees = plan.attendees.map((attendee) => graphAttendee(attendee));
  }
  if (plan.idempotencyKey) {
    body.transactionId = plan.idempotencyKey;
  }
  return body;
}

function graphAttendee(attendee: CalendarAttendee) {
  return {
    emailAddress: {
      address: attendee.email,
      ...(attendee.name ? { name: attendee.name } : {}),
    },
    type: attendee.type ?? "required",
  };
}

export async function listCalendarAgenda(
  client: M365GraphClient,
  params: CalendarAgendaParams,
): Promise<CalendarAgendaResult> {
  const calendarUser = params.calendarUser.trim().toLowerCase();
  const response = await requestGraph(client, {
    method: "GET",
    path: `${calendarUserPath(calendarUser)}/calendarView`,
    query: {
      startDateTime: params.start,
      endDateTime: params.end,
      $orderby: "start/dateTime",
      ...(params.top ? { $top: params.top } : {}),
    },
  });
  return {
    calendarUser,
    start: params.start,
    end: params.end,
    events: parseCalendarEventList(response),
  };
}

export async function findCalendarFreeBusy(
  client: M365GraphClient,
  params: CalendarFreeBusyParams,
): Promise<CalendarFreeBusyResult> {
  const calendarUser = params.calendarUser.trim().toLowerCase();
  const response = await requestGraph(client, {
    method: "POST",
    path: `${calendarUserPath(calendarUser)}/calendar/getSchedule`,
    body: {
      schedules: params.schedules.map((schedule) => schedule.trim().toLowerCase()).filter(Boolean),
      startTime: {
        dateTime: params.start,
        timeZone: params.timeZone,
      },
      endTime: {
        dateTime: params.end,
        timeZone: params.timeZone,
      },
      availabilityViewInterval: params.intervalMinutes ?? 30,
    },
  });
  return {
    calendarUser,
    schedules: parseAvailabilitySchedules(response),
  };
}

export async function getCalendarEvent(
  client: M365GraphClient,
  params: CalendarEventLookupParams,
): Promise<CalendarEvent | undefined> {
  const calendarUser = params.calendarUser.trim().toLowerCase();
  const eventId = params.eventId.trim();
  if (!eventId) {
    throw new Error("eventId required");
  }
  return parseCalendarEvent(
    await requestGraph(client, {
      method: "GET",
      path: `${calendarUserPath(calendarUser)}/events/${encodePathSegment(eventId)}`,
    }),
  );
}

export async function createCalendarEvent(
  client: M365GraphClient,
  plan: CalendarChangePlan,
  expectedPlanHash: string,
): Promise<CalendarWriteResult> {
  assertCalendarPlanHash(plan, expectedPlanHash);
  if (plan.operation !== "create") {
    throw new Error("createCalendarEvent requires a create plan");
  }
  const event = parseCalendarEvent(
    await requestGraph(client, {
      method: "POST",
      path: `${calendarUserPath(plan.calendarUser)}/events`,
      body: graphEventBody(plan),
    }),
  );
  return {
    operation: plan.operation,
    calendarUser: plan.calendarUser,
    planHash: expectedPlanHash,
    ...(event ? { event } : {}),
  };
}

export async function updateCalendarEvent(
  client: M365GraphClient,
  plan: CalendarChangePlan,
  expectedPlanHash: string,
): Promise<CalendarWriteResult> {
  assertCalendarPlanHash(plan, expectedPlanHash);
  if (plan.operation !== "update" || !plan.eventId) {
    throw new Error("updateCalendarEvent requires an update plan with eventId");
  }
  const event = parseCalendarEvent(
    await requestGraph(client, {
      method: "PATCH",
      path: `${calendarUserPath(plan.calendarUser)}/events/${encodePathSegment(plan.eventId)}`,
      body: graphEventBody(plan),
    }),
  );
  return {
    operation: plan.operation,
    calendarUser: plan.calendarUser,
    planHash: expectedPlanHash,
    ...(event ? { event } : {}),
  };
}

export async function cancelCalendarEvent(
  client: M365GraphClient,
  plan: CalendarChangePlan,
  expectedPlanHash: string,
): Promise<CalendarWriteResult> {
  assertCalendarPlanHash(plan, expectedPlanHash);
  if (plan.operation !== "cancel" || !plan.eventId) {
    throw new Error("cancelCalendarEvent requires a cancel plan with eventId");
  }
  await requestGraph(client, {
    method: "POST",
    path: `${calendarUserPath(plan.calendarUser)}/events/${encodePathSegment(plan.eventId)}/cancel`,
    body: {
      comment: plan.comment ?? "",
    },
  });
  return {
    operation: plan.operation,
    calendarUser: plan.calendarUser,
    planHash: expectedPlanHash,
    cancelled: true,
  };
}

export async function executeQueuedCalendarChange(
  client: M365GraphClient,
  plan: CalendarChangePlan,
  expectedPlanHash: string,
): Promise<CalendarWriteResult> {
  if (plan.operation === "create") {
    return await createCalendarEvent(client, plan, expectedPlanHash);
  }
  if (plan.operation === "update") {
    return await updateCalendarEvent(client, plan, expectedPlanHash);
  }
  return await cancelCalendarEvent(client, plan, expectedPlanHash);
}
