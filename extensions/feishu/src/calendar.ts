/**
 * Feishu calendar event creation.
 *
 * Creates events on the bot's own calendar and invites attendees.
 * Uses the two-step approach: create event → add attendees.
 */

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { checkPermissionError } from "./permissions.js";

export type CalendarEventParams = {
  summary: string;
  description?: string;
  startTimestamp: string; // Unix timestamp in seconds (as string)
  endTimestamp: string;
  location?: string;
  attendeeOpenIds?: string[]; // open_ids of attendees
};

type CalendarResult = { eventId: string; calendarId: string } | { error: string };

/**
 * Create a calendar event and optionally add attendees.
 */
export async function createCalendarEvent(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  event: CalendarEventParams;
  calendarId?: string; // If not provided, uses the bot's primary calendar
  log?: (msg: string) => void;
}): Promise<CalendarResult> {
  const { cfg, accountId, event, log } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured || !account.appId) {
    return { error: "飞书账号未配置" };
  }

  const client = createFeishuClient(account);

  // Step 1: Get the bot's primary calendar ID if not provided
  let calendarId = params.calendarId;
  if (!calendarId) {
    try {
      const calResponse = (await client.calendar.calendar.primary({
        // empty params gets the primary calendar
      })) as {
        code?: number;
        msg?: string;
        data?: { calendars?: Array<{ calendar?: { calendar_id?: string } }> };
      };

      if (calResponse.code !== 0) {
        const permErr = checkPermissionError(
          calResponse,
          account.appId,
          "calendar:calendar",
          account.domain,
        );
        if (permErr) return { error: permErr };
        return {
          error: `获取日历失败: ${calResponse.msg || `code ${calResponse.code}`}`,
        };
      }

      calendarId = calResponse.data?.calendars?.[0]?.calendar?.calendar_id;
      if (!calendarId) {
        return { error: "无法获取机器人日历 ID" };
      }
    } catch (err) {
      const permErr = checkPermissionError(err, account.appId, "calendar:calendar", account.domain);
      if (permErr) return { error: permErr };
      return { error: `获取日历失败: ${String(err)}` };
    }
  }

  // Step 2: Create the event
  let eventId: string;
  try {
    const createResponse = (await client.calendar.calendarEvent.create({
      path: { calendar_id: calendarId },
      data: {
        summary: event.summary,
        description: event.description || "",
        start_time: { timestamp: event.startTimestamp },
        end_time: { timestamp: event.endTimestamp },
        ...(event.location ? { location: { name: event.location } } : {}),
        attendee_ability: "can_see_others",
      },
    })) as {
      code?: number;
      msg?: string;
      data?: { event?: { event_id?: string } };
    };

    if (createResponse.code !== 0) {
      const permErr = checkPermissionError(
        createResponse,
        account.appId,
        "calendar:calendar",
        account.domain,
      );
      if (permErr) return { error: permErr };
      return {
        error: `创建日程失败: ${createResponse.msg || `code ${createResponse.code}`}`,
      };
    }

    eventId = createResponse.data?.event?.event_id ?? "";
    if (!eventId) {
      return { error: "创建日程成功但未返回 event_id" };
    }

    log?.(`feishu: created calendar event ${eventId}`);
  } catch (err) {
    const permErr = checkPermissionError(err, account.appId, "calendar:calendar", account.domain);
    if (permErr) return { error: permErr };
    return { error: `创建日程失败: ${String(err)}` };
  }

  // Step 3: Add attendees if provided
  if (event.attendeeOpenIds && event.attendeeOpenIds.length > 0) {
    try {
      const attendees = event.attendeeOpenIds.map((openId) => ({
        type: "user" as const,
        is_optional: false,
        user_id: openId,
      }));

      const attendeeResponse = (await client.calendar.calendarEventAttendee.create({
        path: { calendar_id: calendarId, event_id: eventId },
        params: { user_id_type: "open_id" },
        data: {
          attendees,
          need_notification: true,
        },
      })) as { code?: number; msg?: string };

      if (attendeeResponse.code !== 0) {
        log?.(
          `feishu: warning - event created but failed to add attendees: ${attendeeResponse.msg || `code ${attendeeResponse.code}`}`,
        );
      } else {
        log?.(`feishu: added ${event.attendeeOpenIds.length} attendees to event ${eventId}`);
      }
    } catch (err) {
      log?.(`feishu: warning - event created but failed to add attendees: ${String(err)}`);
    }
  }

  return { eventId, calendarId };
}
