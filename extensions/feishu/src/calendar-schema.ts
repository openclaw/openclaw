import { Type, type Static } from "@sinclair/typebox";

const CALENDAR_ACTION_VALUES = [
  "create_event",
  "add_attendees",
  "list_events",
  "get_event",
  "delete_event",
] as const;

const ATTENDEE_TYPE_VALUES = ["user"] as const;

export const FeishuCalendarSchema = Type.Object({
  action: Type.Unsafe<(typeof CALENDAR_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...CALENDAR_ACTION_VALUES],
    description:
      "Action to run: create_event | add_attendees | list_events | get_event | delete_event",
  }),
  summary: Type.Optional(Type.String({ description: "Event title (required for create_event)" })),
  description: Type.Optional(Type.String({ description: "Event description" })),
  start_time: Type.Optional(
    Type.String({
      description:
        "Start time as ISO 8601 string or unix timestamp in seconds (required for create_event, optional for list_events)",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description:
        "End time as ISO 8601 string or unix timestamp in seconds (defaults to start_time + 1 hour for create_event)",
    }),
  ),
  event_id: Type.Optional(
    Type.String({
      description: "Event ID (required for get_event, delete_event, add_attendees)",
    }),
  ),
  attendees: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Unsafe<(typeof ATTENDEE_TYPE_VALUES)[number]>({
          type: "string",
          enum: [...ATTENDEE_TYPE_VALUES],
          description: "Attendee type",
        }),
        user_id: Type.String({ description: "User open_id" }),
      }),
      { description: "List of attendees to add (for add_attendees)" },
    ),
  ),
  attendee_ability: Type.Optional(
    Type.Unsafe<"none" | "can_see_others" | "can_invite_others" | "can_modify_event">({
      type: "string",
      enum: ["none", "can_see_others", "can_invite_others", "can_modify_event"],
      description:
        "Attendee ability for create_event: none | can_see_others | can_invite_others | can_modify_event",
    }),
  ),
  need_notification: Type.Optional(
    Type.Boolean({ description: "Whether to send notification (default true)" }),
  ),
  page_size: Type.Optional(Type.Number({ description: "Page size for list_events (default 50)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token for list_events" })),
});

export type FeishuCalendarParams = Static<typeof FeishuCalendarSchema>;
