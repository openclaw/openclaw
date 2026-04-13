import { Type } from "@sinclair/typebox";
import { findCalendarFreeBusy, listCalendarAgenda, type M365GraphClient } from "./graph.js";
import { queueCalendarChange } from "./plan.js";
import type { CalendarAttendee, CalendarChangeOperation, CalendarDateTime } from "./types.js";

type CalendarToolOptions = {
  graphClient?: M365GraphClient;
  defaultCalendarUser?: string;
  defaultTimeZone?: string;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

class CalendarToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarToolInputError";
  }
}

function jsonResult(details: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function requireGraphClient(client: M365GraphClient | undefined, action: string): M365GraphClient {
  if (!client) {
    throw new CalendarToolInputError(`${action} requires an M365 Graph client`);
  }
  return client;
}

function readRecord(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new CalendarToolInputError("tool params must be an object");
  }
  return params as Record<string, unknown>;
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = readString(params, key);
  if (!value) {
    throw new CalendarToolInputError(`${key} required`);
  }
  return value;
}

function readStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (Array.isArray(value)) {
    const entries = value.filter((entry): entry is string => typeof entry === "string");
    const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return undefined;
}

function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function readBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function readDateTime(
  params: Record<string, unknown>,
  prefix: "start" | "end",
  defaultTimeZone: string,
): CalendarDateTime | undefined {
  const dateTime = readString(params, prefix);
  if (!dateTime) {
    return undefined;
  }
  return {
    dateTime,
    timeZone:
      readString(params, `${prefix}TimeZone`) ?? readString(params, "timeZone") ?? defaultTimeZone,
  };
}

function readRequiredDateTime(
  params: Record<string, unknown>,
  prefix: "start" | "end",
  defaultTimeZone: string,
): CalendarDateTime {
  const value = readDateTime(params, prefix, defaultTimeZone);
  if (!value) {
    throw new CalendarToolInputError(`${prefix} required`);
  }
  return value;
}

function resolveCalendarUser(
  params: Record<string, unknown>,
  defaultCalendarUser: string | undefined,
): string {
  const calendarUser = readString(params, "calendarUser") ?? defaultCalendarUser?.trim();
  if (!calendarUser) {
    throw new CalendarToolInputError("calendarUser required");
  }
  return calendarUser;
}

function readAttendees(params: Record<string, unknown>): CalendarAttendee[] | undefined {
  const raw = params.attendees;
  if (Array.isArray(raw)) {
    const attendees = raw
      .map((entry) => {
        if (typeof entry === "string") {
          return { email: entry };
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return undefined;
        }
        const record = entry as Record<string, unknown>;
        const email = typeof record.email === "string" ? record.email.trim() : "";
        if (!email) {
          return undefined;
        }
        const name =
          typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
        const type =
          record.type === "optional" || record.type === "resource" || record.type === "required"
            ? record.type
            : undefined;
        return { email, ...(name ? { name } : {}), ...(type ? { type } : {}) };
      })
      .filter((entry): entry is CalendarAttendee => Boolean(entry));
    return attendees.length > 0 ? attendees : undefined;
  }
  const emails = readStringArray(params, "attendees");
  return emails?.map((email) => ({ email }));
}

function readOperation(params: Record<string, unknown>): CalendarChangeOperation {
  const operation = readRequiredString(params, "operation");
  if (operation !== "create" && operation !== "update" && operation !== "cancel") {
    throw new CalendarToolInputError("operation must be create, update, or cancel");
  }
  return operation;
}

export function createM365CalendarTool(options: CalendarToolOptions = {}) {
  const defaultTimeZone = options.defaultTimeZone ?? "UTC";
  return {
    name: "m365_calendar",
    label: "Microsoft 365 Calendar",
    description:
      "Read Microsoft 365 calendar agenda/free-busy data and queue approval-gated calendar changes.",
    parameters: Type.Object({
      action: Type.Unsafe<"agenda" | "free_busy" | "queue_change">({
        type: "string",
        enum: ["agenda", "free_busy", "queue_change"],
      }),
      calendarUser: Type.Optional(Type.String()),
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
      timeZone: Type.Optional(Type.String()),
      startTimeZone: Type.Optional(Type.String()),
      endTimeZone: Type.Optional(Type.String()),
      top: Type.Optional(Type.Number()),
      schedules: Type.Optional(Type.Array(Type.String())),
      intervalMinutes: Type.Optional(Type.Number()),
      operation: Type.Optional(Type.String()),
      eventId: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      bodyContentType: Type.Optional(
        Type.Unsafe<"text" | "html">({ type: "string", enum: ["text", "html"] }),
      ),
      location: Type.Optional(Type.String()),
      attendees: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({
              email: Type.String(),
              name: Type.Optional(Type.String()),
              type: Type.Optional(
                Type.Unsafe<"required" | "optional" | "resource">({
                  type: "string",
                  enum: ["required", "optional", "resource"],
                }),
              ),
            }),
          ]),
        ),
      ),
      comment: Type.Optional(Type.String()),
      notifyAttendees: Type.Optional(Type.Boolean()),
      idempotencyKey: Type.Optional(Type.String()),
    }),
    async execute(rawParams: unknown): Promise<ToolResult> {
      const params = readRecord(rawParams);
      const action = readRequiredString(params, "action");
      const calendarUser = resolveCalendarUser(params, options.defaultCalendarUser);

      if (action === "agenda") {
        const start = readRequiredString(params, "start");
        const end = readRequiredString(params, "end");
        const result = await listCalendarAgenda(requireGraphClient(options.graphClient, action), {
          calendarUser,
          start,
          end,
          ...(readNumber(params, "top") ? { top: readNumber(params, "top") } : {}),
        });
        return jsonResult({ ok: true, action, ...result });
      }

      if (action === "free_busy") {
        const start = readRequiredString(params, "start");
        const end = readRequiredString(params, "end");
        const schedules = readStringArray(params, "schedules") ?? [calendarUser];
        const result = await findCalendarFreeBusy(requireGraphClient(options.graphClient, action), {
          calendarUser,
          schedules,
          start,
          end,
          timeZone: readString(params, "timeZone") ?? defaultTimeZone,
          ...(readNumber(params, "intervalMinutes")
            ? { intervalMinutes: readNumber(params, "intervalMinutes") }
            : {}),
        });
        return jsonResult({ ok: true, action, ...result });
      }

      if (action === "queue_change") {
        const operation = readOperation(params);
        const queuedChange = queueCalendarChange({
          operation,
          calendarUser,
          eventId: readString(params, "eventId"),
          subject: readString(params, "subject"),
          body: readString(params, "body"),
          bodyContentType: params.bodyContentType === "html" ? "html" : "text",
          start: readDateTime(params, "start", defaultTimeZone),
          end: readDateTime(params, "end", defaultTimeZone),
          location: readString(params, "location"),
          attendees: readAttendees(params),
          comment: readString(params, "comment"),
          notifyAttendees: readBoolean(params, "notifyAttendees"),
          idempotencyKey: readString(params, "idempotencyKey"),
        });
        if (operation === "create" || operation === "update") {
          readRequiredDateTime(params, "start", defaultTimeZone);
          readRequiredDateTime(params, "end", defaultTimeZone);
        }
        return jsonResult({ ok: true, action, queuedChange });
      }

      throw new CalendarToolInputError("action must be agenda, free_busy, or queue_change");
    },
  };
}
