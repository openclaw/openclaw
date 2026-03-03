/**
 * DingTalk Document Agent Tool Schema
 *
 * Follows tool schema guardrails: use stringEnum instead of Type.Union
 */

import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, optionalStringEnum } from "openclaw/plugin-sdk/dingtalk";

const DOC_ACTIONS = ["spaces", "create", "list_nodes", "get", "delete"] as const;

const DOC_TYPES = ["alidoc", "folder"] as const;

export const DingtalkDocSchema = Type.Object({
  action: stringEnum(DOC_ACTIONS, {
    description:
      "Action to perform: spaces (list knowledge bases), create (new document), list_nodes (list docs in a space), get (document info), delete (remove document)",
  }),
  user_id: Type.Optional(
    Type.String({
      description:
        "Operator's DingTalk unionId. Optional if operatorUserId is configured in dingtalk config.",
    }),
  ),
  space_id: Type.Optional(
    Type.String({
      description: "Knowledge base (space) ID (required for create/list_nodes/delete)",
    }),
  ),
  name: Type.Optional(Type.String({ description: "Document name (required for create)" })),
  doc_type: optionalStringEnum(DOC_TYPES, {
    description: "Document type: alidoc (default) or folder",
  }),
  parent_node_id: Type.Optional(
    Type.String({ description: "Parent node ID to create under (optional, root if omitted)" }),
  ),
  node_id: Type.Optional(Type.String({ description: "Node ID (required for get/delete)" })),
});

export type DingtalkDocParams = Static<typeof DingtalkDocSchema>;
