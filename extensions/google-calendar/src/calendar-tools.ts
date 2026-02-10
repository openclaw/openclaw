import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

type CalendarPluginConfig = {
  accessToken?: string;
  credentialsPath?: string;
  calendarId?: string;
};

type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  htmlLink?: string;
  status?: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
  creator?: { email: string };
};

type EventsListResponse = {
  items?: CalendarEvent[];
  nextPageToken?: string;
};

function resolveAuth(api: OpenClawPluginApi): string {
  const cfg = api.pluginConfig as CalendarPluginConfig | undefined;
  if (cfg?.accessToken) return cfg.accessToken;
  // Service account JWT flow would go here — for now, accessToken is required
  throw new Error(
    "Google Calendar auth not configured. Set plugins.entries.google-calendar.config.accessToken",
  );
}

function resolveCalendarId(api: OpenClawPluginApi, override?: string): string {
  if (override) return override;
  const cfg = api.pluginConfig as CalendarPluginConfig | undefined;
  return cfg?.calendarId || "primary";
}

async function calendarFetch<T>(
  accessToken: string,
  url: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Calendar API error (${res.status}): ${body || res.statusText}`);
  }

  return (await res.json()) as T;
}

function formatEvent(event: CalendarEvent): string {
  const start = event.start.dateTime || event.start.date || "Unknown";
  const end = event.end.dateTime || event.end.date || "Unknown";
  const parts = [
    event.summary || "(No title)",
    `  When: ${start} → ${end}`,
    event.location ? `  Where: ${event.location}` : null,
    event.description ? `  Description: ${event.description.slice(0, 200)}` : null,
    event.htmlLink ? `  Link: ${event.htmlLink}` : null,
  ];
  return parts.filter(Boolean).join("\n");
}

const BASE_URL = "https://www.googleapis.com/calendar/v3";

export function createCalendarTools(api: OpenClawPluginApi) {
  const listEvents = {
    name: "calendar_list_events",
    description: "List upcoming Google Calendar events.",
    parameters: Type.Object({
      maxResults: Type.Optional(
        Type.Number({ description: "Max events to return (default 10)", minimum: 1, maximum: 100 }),
      ),
      timeMin: Type.Optional(
        Type.String({ description: "Start of time range (ISO 8601 datetime, defaults to now)" }),
      ),
      timeMax: Type.Optional(Type.String({ description: "End of time range (ISO 8601 datetime)" })),
      calendarId: Type.Optional(
        Type.String({ description: "Calendar ID (defaults to config or 'primary')" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const token = resolveAuth(api);
      const calId = resolveCalendarId(api, params.calendarId as string | undefined);
      const maxResults = (params.maxResults as number) || 10;
      const timeMin = (params.timeMin as string) || new Date().toISOString();

      const qs = new URLSearchParams({
        maxResults: String(maxResults),
        timeMin,
        singleEvents: "true",
        orderBy: "startTime",
      });
      if (params.timeMax) qs.set("timeMax", params.timeMax as string);

      const url = `${BASE_URL}/calendars/${encodeURIComponent(calId)}/events?${qs}`;
      const data = await calendarFetch<EventsListResponse>(token, url);
      const events = data.items ?? [];

      if (events.length === 0) {
        return { content: [{ type: "text" as const, text: "No upcoming events found." }] };
      }

      const formatted = events.map(formatEvent).join("\n\n");
      return {
        content: [
          { type: "text" as const, text: `Upcoming events (${events.length}):\n\n${formatted}` },
        ],
      };
    },
  };

  const searchEvents = {
    name: "calendar_search_events",
    description: "Search Google Calendar events by text query.",
    parameters: Type.Object({
      query: Type.String({ description: "Search text to match in event titles and descriptions" }),
      maxResults: Type.Optional(
        Type.Number({ description: "Max events to return (default 10)", minimum: 1, maximum: 100 }),
      ),
      timeMin: Type.Optional(
        Type.String({ description: "Start of time range (ISO 8601 datetime)" }),
      ),
      timeMax: Type.Optional(Type.String({ description: "End of time range (ISO 8601 datetime)" })),
      calendarId: Type.Optional(
        Type.String({ description: "Calendar ID (defaults to config or 'primary')" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const token = resolveAuth(api);
      const calId = resolveCalendarId(api, params.calendarId as string | undefined);
      const maxResults = (params.maxResults as number) || 10;
      const query = params.query as string;

      const qs = new URLSearchParams({
        q: query,
        maxResults: String(maxResults),
        singleEvents: "true",
        orderBy: "startTime",
      });
      if (params.timeMin) qs.set("timeMin", params.timeMin as string);
      if (params.timeMax) qs.set("timeMax", params.timeMax as string);

      const url = `${BASE_URL}/calendars/${encodeURIComponent(calId)}/events?${qs}`;
      const data = await calendarFetch<EventsListResponse>(token, url);
      const events = data.items ?? [];

      if (events.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No events found matching "${query}".` }],
        };
      }

      const formatted = events.map(formatEvent).join("\n\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${events.length} event(s) matching "${query}":\n\n${formatted}`,
          },
        ],
      };
    },
  };

  const createEvent = {
    name: "calendar_create_event",
    description: "Create a new Google Calendar event.",
    parameters: Type.Object({
      summary: Type.String({ description: "Event title" }),
      startTime: Type.String({
        description: "Start time (ISO 8601 datetime, e.g. '2024-03-15T10:00:00-07:00')",
      }),
      endTime: Type.String({ description: "End time (ISO 8601 datetime)" }),
      description: Type.Optional(Type.String({ description: "Event description" })),
      location: Type.Optional(Type.String({ description: "Event location" })),
      attendees: Type.Optional(
        Type.Array(Type.String(), { description: "Attendee email addresses" }),
      ),
      calendarId: Type.Optional(
        Type.String({ description: "Calendar ID (defaults to config or 'primary')" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const token = resolveAuth(api);
      const calId = resolveCalendarId(api, params.calendarId as string | undefined);

      const body: Record<string, unknown> = {
        summary: params.summary,
        start: { dateTime: params.startTime },
        end: { dateTime: params.endTime },
      };
      if (params.description) body.description = params.description;
      if (params.location) body.location = params.location;
      if (Array.isArray(params.attendees)) {
        body.attendees = (params.attendees as string[]).map((email) => ({ email }));
      }

      const url = `${BASE_URL}/calendars/${encodeURIComponent(calId)}/events`;
      const event = await calendarFetch<CalendarEvent>(token, url, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const start = event.start.dateTime || event.start.date || "Unknown";
      return {
        content: [
          {
            type: "text" as const,
            text: `Created event: ${event.summary || "(No title)"}\nWhen: ${start}\n${event.htmlLink ? `Link: ${event.htmlLink}` : ""}`,
          },
        ],
      };
    },
  };

  const getEvent = {
    name: "calendar_get_event",
    description: "Get details of a specific Google Calendar event by its ID.",
    parameters: Type.Object({
      eventId: Type.String({ description: "The event ID" }),
      calendarId: Type.Optional(
        Type.String({ description: "Calendar ID (defaults to config or 'primary')" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const token = resolveAuth(api);
      const calId = resolveCalendarId(api, params.calendarId as string | undefined);
      const eventId = params.eventId as string;

      const url = `${BASE_URL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`;
      const event = await calendarFetch<CalendarEvent>(token, url);

      const parts = [
        event.summary || "(No title)",
        `Status: ${event.status || "confirmed"}`,
        `When: ${event.start.dateTime || event.start.date || "Unknown"} → ${event.end.dateTime || event.end.date || "Unknown"}`,
        event.location ? `Where: ${event.location}` : null,
        event.description ? `Description: ${event.description}` : null,
        event.htmlLink ? `Link: ${event.htmlLink}` : null,
        event.creator ? `Created by: ${event.creator.email}` : null,
      ].filter(Boolean);

      if (event.attendees?.length) {
        parts.push(`Attendees (${event.attendees.length}):`);
        for (const a of event.attendees) {
          parts.push(`  ${a.email} (${a.responseStatus || "pending"})`);
        }
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    },
  };

  return [listEvents, searchEvents, createEvent, getEvent];
}
