import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuCalendarSchema, type FeishuCalendarParams } from "./calendar-schema.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const PRIMARY_CALENDAR_ID = "primary";

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

  const res = await client.calendar.calendarEvent.create({
    path: { calendar_id: PRIMARY_CALENDAR_ID },
    data: {
      summary: params.summary,
      description: params.description,
      need_notification: params.need_notification,
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

  // The Lark SDK types don't expose the attendees sub-resource; cast to any to access it.
  const res = await (client.calendar.calendarEvent as any).attendees.create({
    path: {
      calendar_id: PRIMARY_CALENDAR_ID,
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

  const res = await client.calendar.calendarEvent.list({
    path: { calendar_id: PRIMARY_CALENDAR_ID },
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

  const res = await client.calendar.calendarEvent.get({
    path: {
      calendar_id: PRIMARY_CALENDAR_ID,
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

  const res = await client.calendar.calendarEvent.delete({
    path: {
      calendar_id: PRIMARY_CALENDAR_ID,
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

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.calendar) {
    api.logger.debug?.("feishu_calendar: calendar tool disabled in config");
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_calendar",
      label: "Feishu Calendar",
      description:
        "Feishu calendar operations. Actions: create_event, add_attendees, list_events, get_event, delete_event",
      parameters: FeishuCalendarSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuCalendarParams;
        try {
          const client = getClient();
          switch (p.action) {
            case "create_event":
              return json(await createEvent(client, p));
            case "add_attendees":
              return json(await addAttendees(client, p));
            case "list_events":
              return json(await listEvents(client, p));
            case "get_event":
              return json(await getEvent(client, p));
            case "delete_event":
              return json(await deleteEvent(client, p));
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    { name: "feishu_calendar" },
  );

  api.logger.info?.("feishu_calendar: Registered feishu_calendar tool");
}
