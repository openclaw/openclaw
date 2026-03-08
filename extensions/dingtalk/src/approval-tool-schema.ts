/**
 * DingTalk OA Approval Agent Tool Schema
 *
 * Follows tool schema guardrails: use stringEnum instead of Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/dingtalk";

const APPROVAL_ACTIONS = ["list_templates", "create", "get", "list"] as const;

export const DingtalkApprovalSchema = Type.Object({
  action: stringEnum(APPROVAL_ACTIONS, {
    description:
      "Action to perform: list_templates (available approval templates), create (start new approval), get (approval instance details), list (query approval instances by template)",
  }),
  user_id: Type.Optional(
    Type.String({
      description:
        "Initiator's DingTalk userId. Optional if operatorUserId is configured in dingtalk config.",
    }),
  ),
  process_code: Type.Optional(
    Type.String({
      description: "Approval template process code (required for create, list)",
    }),
  ),
  instance_id: Type.Optional(
    Type.String({
      description: "Approval instance ID (required for get)",
    }),
  ),
  form_values: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({ description: "Form field name" }),
        value: Type.String({ description: "Form field value" }),
      }),
      {
        description:
          "Form field values for creating an approval (required for create). Each item has name and value.",
      },
    ),
  ),
  department_id: Type.Optional(
    Type.String({
      description: "Initiator's department ID (required for create)",
    }),
  ),
  approvers: Type.Optional(
    Type.Array(Type.String(), {
      description: "Approver userIds (optional for create, uses template default if omitted)",
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description: "Start time filter in ISO 8601 format (for list)",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: "End time filter in ISO 8601 format (for list)",
    }),
  ),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor for list operations" })),
  size: Type.Optional(
    Type.Number({ description: "Page size for list operations (default 10, max 20)" }),
  ),
});

export type DingtalkApprovalParams = Static<typeof DingtalkApprovalSchema>;
