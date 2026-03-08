/**
 * DingTalk Calendar Management API
 *
 * Provides complete calendar event management capabilities:
 * - createCalendarEvent: Create calendar event
 * - getCalendarEvent: Get calendar event details
 * - updateCalendarEvent: Update calendar event
 * - deleteCalendarEvent: Delete calendar event
 * - listCalendarEvents: Query calendar event list
 *
 * API Docs:
 * - Create event: https://open.dingtalk.com/document/development/create-event
 * - Query event: https://open.dingtalk.com/document/development/query-details-about-an-event
 * - Update event: https://open.dingtalk.com/document/development/modify-event
 * - Delete event: https://open.dingtalk.com/document/development/delete-event
 * - Event list: https://open.dingtalk.com/document/development/query-event-list
 */

import { getAccessToken } from "./client.js";
import { dingtalkLogger } from "./logger.js";
import type {
  DingtalkConfig,
  CreateCalendarEventParams,
  CalendarEvent,
  UpdateCalendarEventParams,
  ListCalendarEventsParams,
  ListCalendarEventsResult,
} from "./types.js";

/** DingTalk API base URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP request timeout (milliseconds) */
const REQUEST_TIMEOUT = 30_000;

/** Default calendar ID (user's primary calendar) */
const PRIMARY_CALENDAR_ID = "primary";

/** Get system local timezone (IANA format, e.g., Asia/Shanghai, America/New_York) */
function getSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** DingTalk calendar API default timezone: follows system timezone of runtime environment */
const DEFAULT_CALENDAR_TIMEZONE = getSystemTimezone();

// ============================================================================
// Internal Utility Functions
// ============================================================================

interface DingtalkApiErrorResponse {
  code?: string;
  message?: string;
  requestid?: string;
}

async function dingtalkApiRequest<ResponseType>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  accessToken: string,
  options?: {
    body?: Record<string, unknown>;
    query?: Record<string, string>;
    operationLabel?: string;
  },
): Promise<ResponseType> {
  const operationLabel = options?.operationLabel ?? `${method} ${path}`;
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    let url = `${DINGTALK_API_BASE}${path}`;

    if (options?.query) {
      const searchParams = new URLSearchParams(options.query);
      url = `${url}?${searchParams.toString()}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      signal: controller.signal,
    };

    if (options?.body && method !== "GET") {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk ${operationLabel} failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiErrorResponse;
        if (errorData.message) {
          errorMessage = `DingTalk ${operationLabel} failed: ${errorData.message} (code: ${errorData.code ?? "unknown"}, requestId: ${errorData.requestid ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const responseText = await response.text();
    if (!responseText) {
      const elapsed = Date.now() - startTime;
      dingtalkLogger.info?.(`[PERF] API ${operationLabel}: ${elapsed}ms`);
      return {} as ResponseType;
    }

    const elapsed = Date.now() - startTime;
    dingtalkLogger.info?.(`[PERF] API ${operationLabel}: ${elapsed}ms`);
    return JSON.parse(responseText) as ResponseType;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    dingtalkLogger.info?.(`[PERF] API ${operationLabel}: ${elapsed}ms (error)`);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DingTalk ${operationLabel} timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveAccessToken(cfg: DingtalkConfig): Promise<string> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(cfg.clientId, cfg.clientSecret);
}

// ============================================================================
// Calendar Management API
// ============================================================================

/**
 * Create calendar event
 *
 * Create a calendar event in user's primary calendar, supports setting time, location, attendees, reminders, etc.
 *
 * @param cfg DingTalk config
 * @param userId Calendar event organizer's unionId
 * @param params Create calendar event parameters
 * @returns Created calendar event info
 *
 * @example
 * ```ts
 * const event = await createCalendarEvent(cfg, "user123", {
 *   summary: "Weekly Project Meeting",
 *   start: { dateTime: "2024-01-15T14:00:00+08:00" },
 *   end: { dateTime: "2024-01-15T15:00:00+08:00" },
 *   attendees: [{ id: "user456" }],
 * });
 * ```
 */
export async function createCalendarEvent(
  cfg: DingtalkConfig,
  userId: string,
  params: CreateCalendarEventParams,
): Promise<CalendarEvent> {
  const accessToken = await resolveAccessToken(cfg);
  const calendarId = params.calendarId ?? PRIMARY_CALENDAR_ID;

  dingtalkLogger.info(`Creating calendar event "${params.summary}" for user ${userId}`);

  const startWithTimezone = {
    ...params.start,
    timeZone: params.start.timeZone ?? DEFAULT_CALENDAR_TIMEZONE,
  };
  const endWithTimezone = {
    ...params.end,
    timeZone: params.end.timeZone ?? DEFAULT_CALENDAR_TIMEZONE,
  };

  const body: Record<string, unknown> = {
    summary: params.summary,
    start: startWithTimezone,
    end: endWithTimezone,
  };

  if (params.description) body.description = params.description;
  if (params.isAllDay !== undefined) body.isAllDay = params.isAllDay;
  if (params.location) body.location = { displayName: params.location };
  if (params.recurrence) body.recurrence = params.recurrence;
  if (params.attendees?.length) {
    body.attendees = params.attendees.map((attendee) => ({
      id: attendee.id,
      isOptional: attendee.isOptional ?? false,
    }));
  }
  if (params.reminders?.length) {
    body.reminders = params.reminders.map((reminder) => ({
      method: reminder.method ?? "dingtalk",
      minutes: reminder.minutes,
    }));
  }
  if (params.extra) {
    for (const [key, value] of Object.entries(params.extra)) {
      body[key] = value;
    }
  }

  const result = await dingtalkApiRequest<CalendarEvent>(
    "POST",
    `/v1.0/calendar/users/${userId}/calendars/${calendarId}/events`,
    accessToken,
    { body, operationLabel: "create calendar event" },
  );

  dingtalkLogger.info(`Calendar event created: id=${result.id}, summary="${params.summary}"`);
  return result;
}

/**
 * Get calendar event details
 *
 * @param cfg DingTalk config
 * @param userId User's unionId
 * @param eventId Event ID
 * @param calendarId Calendar ID, defaults to primary
 * @returns Calendar event details
 */
export async function getCalendarEvent(
  cfg: DingtalkConfig,
  userId: string,
  eventId: string,
  calendarId?: string,
): Promise<CalendarEvent> {
  const accessToken = await resolveAccessToken(cfg);
  const resolvedCalendarId = calendarId ?? PRIMARY_CALENDAR_ID;

  dingtalkLogger.info(`Getting calendar event ${eventId} for user ${userId}`);

  return dingtalkApiRequest<CalendarEvent>(
    "GET",
    `/v1.0/calendar/users/${userId}/calendars/${resolvedCalendarId}/events/${eventId}`,
    accessToken,
    { operationLabel: "get calendar event" },
  );
}

/**
 * Update calendar event
 *
 * Only organizer can modify the event, userId must be organizer's unionId.
 * Only pass fields that need to be modified, unpassed fields remain unchanged.
 *
 * @param cfg DingTalk config
 * @param userId Organizer's unionId
 * @param eventId Event ID
 * @param params Update parameters
 * @param calendarId Calendar ID, defaults to primary
 * @returns Updated calendar event
 */
export async function updateCalendarEvent(
  cfg: DingtalkConfig,
  userId: string,
  eventId: string,
  params: UpdateCalendarEventParams,
  calendarId?: string,
): Promise<CalendarEvent> {
  const accessToken = await resolveAccessToken(cfg);
  const resolvedCalendarId = calendarId ?? PRIMARY_CALENDAR_ID;

  dingtalkLogger.info(`Updating calendar event ${eventId} for user ${userId}`);

  const body: Record<string, unknown> = {};
  if (params.summary) body.summary = params.summary;
  if (params.description !== undefined) body.description = params.description;
  if (params.start) {
    body.start = { ...params.start, timeZone: params.start.timeZone ?? DEFAULT_CALENDAR_TIMEZONE };
  }
  if (params.end) {
    body.end = { ...params.end, timeZone: params.end.timeZone ?? DEFAULT_CALENDAR_TIMEZONE };
  }
  if (params.isAllDay !== undefined) body.isAllDay = params.isAllDay;
  if (params.location !== undefined) body.location = { displayName: params.location };
  if (params.attendees) {
    body.attendees = params.attendees.map((attendee) => ({
      id: attendee.id,
      isOptional: attendee.isOptional ?? false,
    }));
  }
  if (params.reminders) {
    body.reminders = params.reminders.map((reminder) => ({
      method: reminder.method ?? "dingtalk",
      minutes: reminder.minutes,
    }));
  }

  return dingtalkApiRequest<CalendarEvent>(
    "PUT",
    `/v1.0/calendar/users/${userId}/calendars/${resolvedCalendarId}/events/${eventId}`,
    accessToken,
    { body, operationLabel: "update calendar event" },
  );
}

/**
 * Delete calendar event
 *
 * @param cfg DingTalk config
 * @param userId Organizer's unionId
 * @param eventId Event ID
 * @param calendarId Calendar ID, defaults to primary
 */
export async function deleteCalendarEvent(
  cfg: DingtalkConfig,
  userId: string,
  eventId: string,
  calendarId?: string,
): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);
  const resolvedCalendarId = calendarId ?? PRIMARY_CALENDAR_ID;

  dingtalkLogger.info(`Deleting calendar event ${eventId} for user ${userId}`);

  await dingtalkApiRequest<Record<string, unknown>>(
    "DELETE",
    `/v1.0/calendar/users/${userId}/calendars/${resolvedCalendarId}/events/${eventId}`,
    accessToken,
    { operationLabel: "delete calendar event" },
  );

  dingtalkLogger.info(`Calendar event ${eventId} deleted`);
}

/**
 * Query calendar event list
 *
 * Query calendar events within specified time range.
 *
 * @param cfg DingTalk config
 * @param userId User's unionId
 * @param params Query parameters
 * @returns Calendar event list
 */
export async function listCalendarEvents(
  cfg: DingtalkConfig,
  userId: string,
  params?: ListCalendarEventsParams,
): Promise<ListCalendarEventsResult> {
  const accessToken = await resolveAccessToken(cfg);
  const calendarId = params?.calendarId ?? PRIMARY_CALENDAR_ID;

  dingtalkLogger.info(`Listing calendar events for user ${userId}`);

  const query: Record<string, string> = {};
  if (params?.timeMin) query.timeMin = params.timeMin;
  if (params?.timeMax) query.timeMax = params.timeMax;
  if (params?.maxResults) query.maxResults = String(params.maxResults);
  if (params?.nextToken) query.nextToken = params.nextToken;
  if (params?.showDeleted !== undefined) query.showDeleted = String(params.showDeleted);

  return dingtalkApiRequest<ListCalendarEventsResult>(
    "GET",
    `/v1.0/calendar/users/${userId}/calendars/${calendarId}/events`,
    accessToken,
    { query, operationLabel: "list calendar events" },
  );
}
