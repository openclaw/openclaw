/**
 * DingTalk Contact Agent Tool Schema
 *
 * Follows tool schema guardrails: use stringEnum instead of Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/dingtalk";

const CONTACT_ACTIONS = [
  "list_departments",
  "get_department",
  "list_users",
  "get_user",
  "get_user_by_staff_id",
  "get_user_by_auth_code",
] as const;

export const DingtalkContactSchema = Type.Object({
  action: stringEnum(CONTACT_ACTIONS, {
    description:
      "Action to perform: list_departments (list sub-departments), get_department (department details), list_users (users in a department), get_user (user details by unionId), get_user_by_staff_id (user details by staffId/userid via legacy API, returns full profile including unionid), get_user_by_auth_code (get user info via DingTalk auth code from JSAPI)",
  }),
  department_id: Type.Optional(
    Type.String({
      description:
        "Department ID. Use '1' for root department. Required for list_departments, get_department, list_users.",
    }),
  ),
  user_id: Type.Optional(
    Type.String({
      description:
        "User's DingTalk userId. Required for get_user. Optional for other actions if operatorUserId is configured.",
    }),
  ),
  staff_id: Type.Optional(
    Type.String({
      description:
        "User's DingTalk staffId (also called userid, e.g. 024555303506893180657). Required for get_user_by_staff_id. Uses legacy oapi to return full user profile including unionid, name, department, job number, etc.",
    }),
  ),
  auth_code: Type.Optional(
    Type.String({
      description:
        "DingTalk auth code (免登码) obtained from JSAPI dd.runtime.permission.requestAuthCode. Required for get_user_by_auth_code.",
    }),
  ),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor for list operations" })),
  size: Type.Optional(
    Type.Number({ description: "Page size for list operations (default 20, max 100)" }),
  ),
});

export type DingtalkContactParams = Static<typeof DingtalkContactSchema>;
