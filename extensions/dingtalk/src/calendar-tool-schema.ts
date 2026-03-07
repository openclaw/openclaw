/**
 * DingTalk Calendar Agent Tool Schema
 *
 * Follows tool schema guardrails: use stringEnum instead of Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/dingtalk";

const CALENDAR_ACTIONS = ["create", "list", "get", "update", "delete"] as const;

export const DingtalkCalendarSchema = Type.Object({
  action: stringEnum(CALENDAR_ACTIONS, {
    description:
      "Action to perform: create (new event), list (upcoming events), get (event details), update, delete",
  }),
  user_id: Type.Optional(
    Type.String({
      description:
        "Organizer's DingTalk unionId. Optional if operatorUserId is configured in dingtalk config.",
    }),
  ),
  summary: Type.Optional(Type.String({ description: "Event title/summary (required for create)" })),
  description: Type.Optional(Type.String({ description: "Event description" })),
  start_time: Type.Optional(
    Type.String({
      description: "Start time in ISO 8601 format, e.g. 2024-12-31T14:00:00+08:00 (for create)",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: "End time in ISO 8601 format, e.g. 2024-12-31T15:00:00+08:00 (for create)",
    }),
  ),
  location: Type.Optional(Type.String({ description: "Event location" })),
  attendee_ids: Type.Optional(Type.Array(Type.String(), { description: "Attendee unionIds" })),
  reminder_minutes: Type.Optional(
    Type.Number({ description: "Reminder before event in minutes (e.g. 15)" }),
  ),
  is_all_day: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event" })),
  event_id: Type.Optional(
    Type.String({ description: "Event ID (required for get/update/delete)" }),
  ),
});

export type DingtalkCalendarParams = Static<typeof DingtalkCalendarSchema>;
