/**
 * DingTalk CoolApp Agent Tool Schema
 *
 * Supports TopBox creation and closing operations.
 * Follows tool schema guardrails: use stringEnum instead of Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/dingtalk";

const COOLAPP_ACTIONS = ["create_topbox", "close_topbox"] as const;

export const DingtalkCoolAppSchema = Type.Object({
  action: stringEnum(COOLAPP_ACTIONS, {
    description:
      "Action to perform: create_topbox (create and open a TopBox card pinned at the top of a group chat), close_topbox (close/remove a TopBox card)",
  }),
  open_conversation_id: Type.String({
    description: "Group chat openConversationId where the TopBox will be displayed",
  }),
  cool_app_code: Type.String({
    description: "CoolApp code, e.g. COOLAPP-1-xxxx (from DingTalk developer console)",
  }),
  card_template_id: Type.Optional(
    Type.String({
      description: "Interactive card template ID (required for create_topbox)",
    }),
  ),
  out_track_id: Type.Optional(
    Type.String({
      description:
        "User-defined unique card tracking ID. Auto-generated if not provided for create_topbox. Required for close_topbox.",
    }),
  ),
  card_data: Type.Optional(
    Type.String({
      description:
        'Public card data as JSON string, e.g. {"text":"Hello","picture":"@lADPxxx"}. Keys must match template variables.',
    }),
  ),
  platforms: Type.Optional(
    Type.String({
      description:
        'Target platforms separated by |, e.g. "ios|mac|android|win". Defaults to all platforms.',
    }),
  ),
  callback_route_key: Type.Optional(
    Type.String({
      description: "Callback route key for card interaction callbacks",
    }),
  ),
});

export type DingtalkCoolAppParams = Static<typeof DingtalkCoolAppSchema>;
