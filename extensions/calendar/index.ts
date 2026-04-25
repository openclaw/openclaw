/**
 * @openclaw/calendar
 *
 * Google Calendar control as openclaw tools. Six tools mirror the Calendar
 * v3 surface the agent realistically needs: list, create, update, delete,
 * quick-add (natural language), and free-time finder.
 *
 * Reuses the same Google OAuth client as @openclaw/inbox-triage — see the
 * README for re-running the auth helper to add the `calendar` scope to the
 * existing refresh token.
 */

import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { CalendarClient, type CalEvent } from "./calendar-client.js";
import { calendarConfigSchema } from "./config.js";

function summariseEvent(e: CalEvent): string {
  const start = e.start.dateTime ?? e.start.date ?? "";
  const end = e.end.dateTime ?? e.end.date ?? "";
  const where = e.location ? ` @ ${e.location}` : "";
  const who =
    e.attendees.length > 0
      ? ` (with ${e.attendees.map((a) => a.email).slice(0, 3).join(", ")}${e.attendees.length > 3 ? "…" : ""})`
      : "";
  return `${start} → ${end} | ${e.summary}${where}${who}`;
}

export default definePluginEntry({
  id: "calendar",
  name: "Calendar",
  description:
    "Read and write the user's Google Calendar — list events, create / update / delete, quick-add, and find free time.",
  configSchema: calendarConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = calendarConfigSchema.parse(api.pluginConfig);
    const client = new CalendarClient({
      clientId: cfg.google.clientId,
      clientSecret: cfg.google.clientSecret,
      refreshToken: cfg.google.refreshToken,
    });

    api.logger.info(
      `calendar: ready (user=${cfg.google.user}, default=${cfg.defaultCalendarId}, tz=${cfg.timezone}, writes=${cfg.writeEnabled})`,
    );

    // -----------------------------------------------------------------------
    // Read tools — always enabled
    // -----------------------------------------------------------------------

    api.registerTool(
      {
        name: "calendar_list_events",
        label: "List Events",
        description:
          "List events from the user's Google Calendar between timeMin and timeMax. " +
          "Use this whenever the user asks 'what's on my calendar', 'am I free', or 'what's tomorrow'.",
        parameters: Type.Object({
          timeMin: Type.Optional(
            Type.String({
              description: "ISO 8601 start (default: now)",
            }),
          ),
          timeMax: Type.Optional(
            Type.String({
              description: "ISO 8601 end (default: 7 days from now)",
            }),
          ),
          calendarId: Type.Optional(Type.String({ description: "Default: primary" })),
          query: Type.Optional(
            Type.String({ description: "Free-text filter passed to Google's q parameter" }),
          ),
          maxResults: Type.Optional(Type.Number({ description: "Default 50, max 250" })),
        }),
        async execute(_id, params) {
          const p = params as {
            timeMin?: string;
            timeMax?: string;
            calendarId?: string;
            query?: string;
            maxResults?: number;
          };
          const timeMinIso = p.timeMin ?? new Date().toISOString();
          const timeMaxIso =
            p.timeMax ?? new Date(Date.now() + 7 * 86400_000).toISOString();
          const events = await client.listEvents({
            calendarId: p.calendarId ?? cfg.defaultCalendarId,
            timeMinIso,
            timeMaxIso,
            q: p.query,
            maxResults: Math.min(p.maxResults ?? 50, 250),
          });
          const text =
            events.length === 0
              ? "No events in that window."
              : events.map((e) => `- ${summariseEvent(e)} [${e.id}]`).join("\n");
          return {
            content: [{ type: "text", text }],
            details: { count: events.length, events },
          };
        },
      },
      { name: "calendar_list_events" },
    );

    api.registerTool(
      {
        name: "calendar_find_free_time",
        label: "Find Free Time",
        description:
          "Find candidate free slots of `durationMinutes` within the next `withinDays` days, " +
          "respecting the user's working hours.",
        parameters: Type.Object({
          durationMinutes: Type.Number({ description: "Required slot length in minutes" }),
          withinDays: Type.Optional(
            Type.Number({ description: "Look-ahead window in days (default 7)" }),
          ),
          calendarIds: Type.Optional(
            Type.Array(Type.String(), {
              description: "Calendars to check; default ['primary']",
            }),
          ),
          workingDayStartHour: Type.Optional(Type.Number({ description: "Default 9" })),
          workingDayEndHour: Type.Optional(Type.Number({ description: "Default 18" })),
          limit: Type.Optional(Type.Number({ description: "Max slots to return (default 5)" })),
        }),
        async execute(_id, params) {
          const p = params as {
            durationMinutes: number;
            withinDays?: number;
            calendarIds?: string[];
            workingDayStartHour?: number;
            workingDayEndHour?: number;
            limit?: number;
          };
          const days = Math.max(1, Math.min(60, p.withinDays ?? 7));
          const slots = await client.findFreeSlots({
            calendarIds: p.calendarIds ?? [cfg.defaultCalendarId],
            timeMinIso: new Date().toISOString(),
            timeMaxIso: new Date(Date.now() + days * 86400_000).toISOString(),
            timezone: cfg.timezone,
            durationMinutes: p.durationMinutes,
            limit: p.limit,
            workingDayStartHour: p.workingDayStartHour,
            workingDayEndHour: p.workingDayEndHour,
          });
          const text =
            slots.length === 0
              ? "No free slots found in window."
              : slots.map((s, i) => `${i + 1}. ${s.start} → ${s.end}`).join("\n");
          return {
            content: [{ type: "text", text }],
            details: { count: slots.length, slots },
          };
        },
      },
      { name: "calendar_find_free_time" },
    );

    // -----------------------------------------------------------------------
    // Write tools — gated by config.writeEnabled
    // -----------------------------------------------------------------------

    if (!cfg.writeEnabled) {
      api.logger.info("calendar: writes disabled by config — skipping create/update/delete tools");
      api.registerService({
        id: "calendar",
        start: () => api.logger.info("calendar: started (read-only)"),
        stop: () => api.logger.info("calendar: stopped"),
      });
      return;
    }

    api.registerTool(
      {
        name: "calendar_create_event",
        label: "Create Event",
        description:
          "Create a new calendar event. Always confirm with the user before calling unless they explicitly told you to schedule it.",
        parameters: Type.Object({
          summary: Type.String({ description: "Event title" }),
          startIso: Type.String({ description: "ISO 8601 start datetime in event's timezone" }),
          endIso: Type.String({ description: "ISO 8601 end datetime" }),
          description: Type.Optional(Type.String()),
          location: Type.Optional(Type.String()),
          attendees: Type.Optional(
            Type.Array(Type.String(), { description: "Email addresses to invite" }),
          ),
          calendarId: Type.Optional(Type.String({ description: "Default: primary" })),
          sendInvites: Type.Optional(
            Type.Boolean({ description: "Email invites to attendees? Default false." }),
          ),
        }),
        async execute(_id, params) {
          const p = params as {
            summary: string;
            startIso: string;
            endIso: string;
            description?: string;
            location?: string;
            attendees?: string[];
            calendarId?: string;
            sendInvites?: boolean;
          };
          const event = await client.createEvent({
            calendarId: p.calendarId ?? cfg.defaultCalendarId,
            summary: p.summary,
            description: p.description,
            location: p.location,
            startIso: p.startIso,
            endIso: p.endIso,
            timezone: cfg.timezone,
            attendees: p.attendees,
            sendUpdates: p.sendInvites ? "all" : "none",
          });
          return {
            content: [
              { type: "text", text: `Created: ${summariseEvent(event)}\n${event.htmlLink}` },
            ],
            details: { event },
          };
        },
      },
      { name: "calendar_create_event" },
    );

    api.registerTool(
      {
        name: "calendar_quick_add",
        label: "Quick Add",
        description:
          "Use Google's natural-language event parser. Pass strings like " +
          "'Lunch with Sarah next Tuesday 1pm at Noma'. Faster than calendar_create_event " +
          "for casual one-line events.",
        parameters: Type.Object({
          text: Type.String({ description: "Natural-language event description" }),
          calendarId: Type.Optional(Type.String({ description: "Default: primary" })),
        }),
        async execute(_id, params) {
          const p = params as { text: string; calendarId?: string };
          const event = await client.quickAdd({
            calendarId: p.calendarId ?? cfg.defaultCalendarId,
            text: p.text,
          });
          return {
            content: [
              { type: "text", text: `Quick-added: ${summariseEvent(event)}\n${event.htmlLink}` },
            ],
            details: { event },
          };
        },
      },
      { name: "calendar_quick_add" },
    );

    api.registerTool(
      {
        name: "calendar_update_event",
        label: "Update Event",
        description:
          "Edit an existing event. Pass only the fields that change. Always confirm with the user when changing time or attendees.",
        parameters: Type.Object({
          eventId: Type.String({ description: "From calendar_list_events" }),
          calendarId: Type.Optional(Type.String({ description: "Default: primary" })),
          summary: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          location: Type.Optional(Type.String()),
          startIso: Type.Optional(Type.String()),
          endIso: Type.Optional(Type.String()),
          attendees: Type.Optional(Type.Array(Type.String())),
          sendInvites: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, params) {
          const p = params as {
            eventId: string;
            calendarId?: string;
            summary?: string;
            description?: string;
            location?: string;
            startIso?: string;
            endIso?: string;
            attendees?: string[];
            sendInvites?: boolean;
          };
          const event = await client.updateEvent({
            calendarId: p.calendarId ?? cfg.defaultCalendarId,
            eventId: p.eventId,
            patch: {
              summary: p.summary,
              description: p.description,
              location: p.location,
              startIso: p.startIso,
              endIso: p.endIso,
              timezone: cfg.timezone,
              attendees: p.attendees,
            },
            sendUpdates: p.sendInvites ? "all" : "none",
          });
          return {
            content: [{ type: "text", text: `Updated: ${summariseEvent(event)}` }],
            details: { event },
          };
        },
      },
      { name: "calendar_update_event" },
    );

    api.registerTool(
      {
        name: "calendar_delete_event",
        label: "Delete Event",
        description:
          "Delete a calendar event. Always confirm with the user first; this is destructive.",
        parameters: Type.Object({
          eventId: Type.String({ description: "From calendar_list_events" }),
          calendarId: Type.Optional(Type.String({ description: "Default: primary" })),
          notifyAttendees: Type.Optional(
            Type.Boolean({ description: "Send cancellation emails. Default false." }),
          ),
        }),
        async execute(_id, params) {
          const p = params as {
            eventId: string;
            calendarId?: string;
            notifyAttendees?: boolean;
          };
          await client.deleteEvent({
            calendarId: p.calendarId ?? cfg.defaultCalendarId,
            eventId: p.eventId,
            sendUpdates: p.notifyAttendees ? "all" : "none",
          });
          return {
            content: [{ type: "text", text: `Deleted ${p.eventId}.` }],
            details: { eventId: p.eventId },
          };
        },
      },
      { name: "calendar_delete_event" },
    );

    api.registerService({
      id: "calendar",
      start: () => api.logger.info("calendar: started (read+write)"),
      stop: () => api.logger.info("calendar: stopped"),
    });
  },
});
