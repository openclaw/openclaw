import { Type, type Static } from "@sinclair/typebox";

const FEISHU_WIKI_ACTION_VALUES = [
  "spaces",
  "nodes",
  "get",
  "search",
  "create",
  "move",
  "rename",
] as const;
const FEISHU_WIKI_OBJECT_TYPE_VALUES = ["docx", "sheet", "bitable"] as const;

export const FeishuWikiSchema = Type.Object(
  {
    action: Type.Unsafe<(typeof FEISHU_WIKI_ACTION_VALUES)[number]>({
      type: "string",
      enum: [...FEISHU_WIKI_ACTION_VALUES],
      description: "Wiki action to run: spaces, nodes, get, search, create, move, rename",
    }),
    space_id: Type.Optional(
      Type.String({
        description: "Knowledge space ID. Required for nodes, create, move, and rename.",
      }),
    ),
    parent_node_token: Type.Optional(
      Type.String({
        description: "Optional parent node token for nodes/create. Omit for the root level.",
      }),
    ),
    token: Type.Optional(
      Type.String({ description: "Wiki node token. Required for get." }),
    ),
    query: Type.Optional(
      Type.String({ description: "Search query. Required for search." }),
    ),
    title: Type.Optional(
      Type.String({ description: "Node title. Required for create and rename." }),
    ),
    obj_type: Type.Optional(
      Type.Unsafe<(typeof FEISHU_WIKI_OBJECT_TYPE_VALUES)[number]>({
        type: "string",
        enum: [...FEISHU_WIKI_OBJECT_TYPE_VALUES],
        description: "Object type for create (default: docx).",
      }),
    ),
    node_token: Type.Optional(
      Type.String({ description: "Node token. Required for move and rename." }),
    ),
    target_space_id: Type.Optional(
      Type.String({ description: "Optional target space for move." }),
    ),
    target_parent_token: Type.Optional(
      Type.String({ description: "Optional target parent node token for move." }),
    ),
  },
  { additionalProperties: false },
);

export type FeishuWikiParams = Static<typeof FeishuWikiSchema>;
