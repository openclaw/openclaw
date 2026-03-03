/**
 * DingTalk Attendance Agent Tool Schema
 *
 * Follows tool schema guardrails: use stringEnum instead of Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/dingtalk";

const ATTENDANCE_ACTIONS = ["get_records", "get_status", "get_leave_records"] as const;

export const DingtalkAttendanceSchema = Type.Object({
  action: stringEnum(ATTENDANCE_ACTIONS, {
    description:
      "Action to perform: get_records (attendance punch records), get_status (attendance status/results), get_leave_records (leave/time-off records)",
  }),
  user_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "List of DingTalk userIds to query attendance for (required for get_records, get_status)",
    }),
  ),
  start_date: Type.Optional(
    Type.String({
      description:
        "Start date in YYYY-MM-DD format (required for get_records, get_status, get_leave_records)",
    }),
  ),
  end_date: Type.Optional(
    Type.String({
      description:
        "End date in YYYY-MM-DD format (required for get_records, get_status, get_leave_records)",
    }),
  ),
  user_id: Type.Optional(
    Type.String({
      description:
        "Operator's DingTalk userId. Optional if operatorUserId is configured in dingtalk config.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({ description: "Pagination offset for leave records (default 0)" }),
  ),
  size: Type.Optional(
    Type.Number({ description: "Page size for leave records (default 20, max 100)" }),
  ),
});

export type DingtalkAttendanceParams = Static<typeof DingtalkAttendanceSchema>;
