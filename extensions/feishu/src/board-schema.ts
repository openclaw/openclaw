import { Type, type Static } from "@sinclair/typebox";

const BOARD_ACTION_VALUES = [
  "create_whiteboard",
  "create_node",
  "create_plantuml",
  "list_nodes",
  "get_theme",
  "update_theme",
  "download_image",
] as const;

const THEME_VALUES = [
  "classic",
  "minimalist_gray",
  "retro",
  "vibrant_color",
  "minimalist_blue",
  "default",
] as const;

const NODE_TYPE_VALUES = [
  "image",
  "text_shape",
  "group",
  "composite_shape",
  "svg",
  "connector",
  "table",
  "life_line",
  "activation",
  "section",
  "table_uml",
  "table_er",
  "sticky_note",
  "mind_map",
  "paint",
  "combined_fragment",
] as const;

export const FeishuBoardSchema = Type.Object({
  action: Type.Unsafe<(typeof BOARD_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...BOARD_ACTION_VALUES],
    description:
      "Action to run: create_whiteboard | create_node | create_plantuml | list_nodes | get_theme | update_theme | download_image",
  }),
  whiteboard_id: Type.Optional(
    Type.String({
      description: "Whiteboard ID (required for all actions except create_whiteboard)",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "Whiteboard title (optional, for create_whiteboard)",
    }),
  ),
  folder_token: Type.Optional(
    Type.String({
      description: "Folder token to create whiteboard in (optional, for create_whiteboard)",
    }),
  ),
  nodes: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Unsafe<(typeof NODE_TYPE_VALUES)[number]>({
          type: "string",
          enum: [...NODE_TYPE_VALUES],
          description: "Node type",
        }),
        x: Type.Optional(Type.Number({ description: "X position" })),
        y: Type.Optional(Type.Number({ description: "Y position" })),
        width: Type.Optional(Type.Number({ description: "Node width" })),
        height: Type.Optional(Type.Number({ description: "Node height" })),
        text: Type.Optional(Type.String({ description: "Node text content" })),
        parent_id: Type.Optional(Type.String({ description: "Parent node ID" })),
      }),
      { description: "Array of nodes to create (required for create_node)" },
    ),
  ),
  plant_uml_code: Type.Optional(
    Type.String({
      description:
        "PlantUML code for creating diagrams such as mind maps, flowcharts, sequence diagrams (required for create_plantuml)",
    }),
  ),
  style_type: Type.Optional(Type.Number({ description: "PlantUML style type (optional)" })),
  syntax_type: Type.Optional(Type.Number({ description: "PlantUML syntax type (optional)" })),
  diagram_type: Type.Optional(Type.Number({ description: "PlantUML diagram type (optional)" })),
  theme: Type.Optional(
    Type.Unsafe<(typeof THEME_VALUES)[number]>({
      type: "string",
      enum: [...THEME_VALUES],
      description:
        "Whiteboard theme (required for update_theme): classic | minimalist_gray | retro | vibrant_color | minimalist_blue | default",
    }),
  ),
});

export type FeishuBoardParams = Static<typeof FeishuBoardSchema>;
