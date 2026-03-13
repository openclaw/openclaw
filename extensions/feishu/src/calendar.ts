import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuCalendarSchema, type FeishuCalendarParams } from "./calendar-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";

/**
 * Resolved calendar ID cache.  Tenant tokens cannot use the literal
 * "primary" alias — we must first list calendars and locate the one
 * whose type is "primary", then use its real calendar_id for all
 * subsequent requests.
 */
let resolvedCalendarId: string | null = null;

async function resolvePrimaryCalendarId(client: Lark.Client): Promise<string> {
  if (resolvedCalendarId) return resolvedCalendarId;

  const res = await client.calendar.calendar.list({});
  if (res.code !== 0) {
    throw new Error(`Failed to list calendars: ${res.msg}`);
  }

  // SDK types don't include the "type" field on calendar items, so we cast to any.
  const primary = res.data?.calendar_list?.find((c) => (c as any).type === "primary");

  if (!primary?.calendar_id) {
    throw new Error("No primary calendar found for this app. Ensure the bot has a calendar.");
  }

  resolvedCalendarId = primary.calendar_id;
  return resolvedCalendarId;
}

/**
 * Convert an ISO 8601 string or numeric timestamp string to a Unix timestamp string (seconds).
 */
function toUnixTimestamp(value: string): string {
  // If already a pure numeric value, treat as unix timestamp in seconds
  if (/^\d+$/.test(value)) {
    return value;
  }
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid time value: ${value}`);
  }
  return String(Math.floor(ms / 1000));
}

async function createEvent(client: Lark.Client, params: FeishuCalendarParams) {
  if (!params.summary) {
    throw new Error("summary is required for create_event");
  }
  if (!params.start_time) {
    throw new Error("start_time is required for create_event");
  }

  const startTimestamp = toUnixTimestamp(params.start_time);
  const endTimestamp = params.end_time
    ? toUnixTimestamp(params.end_time)
    : String(Number(startTimestamp) + 3600);

  const calendarId = await resolvePrimaryCalendarId(client);
  const res = await client.calendar.calendarEvent.create({
    path: { calendar_id: calendarId },
    data: {
      summary: params.summary,
      description: params.description,
      need_notification: params.need_notification,
      attendee_ability: params.attendee_ability,
      start_time: { timestamp: startTimestamp },
      end_time: { timestamp: endTimestamp },
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    event_id: res.data?.event?.event_id,
    summary: res.data?.event?.summary,
    start_time: res.data?.event?.start_time,
    end_time: res.data?.event?.end_time,
    status: res.data?.event?.status,
  };
}

async function addAttendees(client: Lark.Client, params: FeishuCalendarParams) {
  if (!params.event_id) {
    throw new Error("event_id is required for add_attendees");
  }
  if (!params.attendees || params.attendees.length === 0) {
    throw new Error("attendees array is required for add_attendees");
  }

  const calendarId = await resolvePrimaryCalendarId(client);
  // SDK types for calendarEventAttendee.create may not match the actual API shape,
  // so we use a type assertion here.
  const res = await client.calendar.calendarEventAttendee.create({
    path: {
      calendar_id: calendarId,
      event_id: params.event_id,
    },
    data: {
      attendees: params.attendees.map((a) => ({
        type: a.type,
        user_id: a.user_id,
      })),
      need_notification: params.need_notification,
    },
    params: {
      user_id_type: "open_id",
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    event_id: params.event_id,
    attendees: res.data?.attendees ?? [],
  };
}

async function listEvents(client: Lark.Client, params: FeishuCalendarParams) {
  const queryParams: Record<string, unknown> = {};

  if (params.start_time) {
    queryParams.start_time = toUnixTimestamp(params.start_time);
  }
  if (params.end_time) {
    queryParams.end_time = toUnixTimestamp(params.end_time);
  }
  if (params.page_size) {
    queryParams.page_size = Math.max(1, Math.min(100, params.page_size));
  }
  if (params.page_token) {
    queryParams.page_token = params.page_token;
  }

  const calendarId = await resolvePrimaryCalendarId(client);
  // SDK types for list params are incomplete, so we cast to any.
  const res = await client.calendar.calendarEvent.list({
    path: { calendar_id: calendarId },
    params: queryParams as any,
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    events:
      res.data?.items?.map((item) => ({
        event_id: item.event_id,
        summary: item.summary,
        description: item.description,
        start_time: item.start_time,
        end_time: item.end_time,
        status: item.status,
      })) ?? [],
  };
}

async function getEvent(client: Lark.Client, params: FeishuCalendarParams) {
  if (!params.event_id) {
    throw new Error("event_id is required for get_event");
  }

  const calendarId = await resolvePrimaryCalendarId(client);
  const res = await client.calendar.calendarEvent.get({
    path: {
      calendar_id: calendarId,
      event_id: params.event_id,
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    event_id: res.data?.event?.event_id,
    summary: res.data?.event?.summary,
    description: res.data?.event?.description,
    start_time: res.data?.event?.start_time,
    end_time: res.data?.event?.end_time,
    status: res.data?.event?.status,
    attendee_ability: res.data?.event?.attendee_ability,
    visibility: res.data?.event?.visibility,
    location: res.data?.event?.location,
  };
}

async function deleteEvent(client: Lark.Client, params: FeishuCalendarParams) {
  if (!params.event_id) {
    throw new Error("event_id is required for delete_event");
  }

  const calendarId = await resolvePrimaryCalendarId(client);
  // SDK types for delete params don't include need_notification, so we cast to any.
  const res = await client.calendar.calendarEvent.delete({
    path: {
      calendar_id: calendarId,
      event_id: params.event_id,
    },
    params: {
      need_notification: params.need_notification,
    } as any,
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    event_id: params.event_id,
    deleted: true,
  };
}

export function registerFeishuCalendarTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_calendar: No config available, skipping calendar tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_calendar: No Feishu accounts configured, skipping calendar tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.calendar) {
    api.logger.debug?.("feishu_calendar: calendar tool disabled in config");
    return;
  }

  type FeishuCalendarExecuteParams = FeishuCalendarParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_calendar",
        label: "Feishu Calendar",
        description:
          "Feishu calendar operations. Actions: create_event, add_attendees, list_events, get_event, delete_event",
        parameters: FeishuCalendarSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuCalendarExecuteParams;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            });
            switch (p.action) {
              case "create_event":
                return jsonToolResult(await createEvent(client, p));
              case "add_attendees":
                return jsonToolResult(await addAttendees(client, p));
              case "list_events":
                return jsonToolResult(await listEvents(client, p));
              case "get_event":
                return jsonToolResult(await getEvent(client, p));
              case "delete_event":
                return jsonToolResult(await deleteEvent(client, p));
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_calendar" },
  );

  api.logger.info?.("feishu_calendar: Registered feishu_calendar tool");
}
