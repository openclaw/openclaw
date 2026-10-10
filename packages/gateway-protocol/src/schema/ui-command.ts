import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const UiSplitCommandSchema = closedObject({
  kind: Type.Literal("split"),
  direction: Type.Union([Type.Literal("right"), Type.Literal("down")]),
  sessionKey: NonEmptyString,
});
export const UiClosePaneCommandSchema = closedObject({
  kind: Type.Literal("close-pane"),
  sessionKey: NonEmptyString,
});
export const UiFocusCommandSchema = closedObject({
  kind: Type.Literal("focus"),
  sessionKey: NonEmptyString,
});
export const UiSidebarCommandSchema = closedObject({
  kind: Type.Literal("sidebar"),
  visible: Type.Boolean(),
});
const UiPanelCommandFields = {
  kind: Type.Literal("panel"),
  open: Type.Boolean(),
  dock: Type.Optional(Type.Union([Type.Literal("bottom"), Type.Literal("right")])),
};
export const UiPanelCommandSchema = Type.Union([
  closedObject({
    ...UiPanelCommandFields,
    panel: Type.Literal("plugin"),
    pluginId: NonEmptyString,
    panelId: NonEmptyString,
  }),
  closedObject({
    ...UiPanelCommandFields,
    panel: Type.Literal("terminal"),
    terminalSessionId: Type.Optional(NonEmptyString),
  }),
  closedObject({ ...UiPanelCommandFields, panel: Type.Literal("browser") }),
  closedObject({
    ...UiPanelCommandFields,
    panel: Type.Literal("desktop"),
    environmentId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...UiPanelCommandFields,
    panel: Type.Literal("portal"),
    portalId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...UiPanelCommandFields,
    panel: Type.Literal("portal"),
    environmentId: NonEmptyString,
  }),
]);
export const UiNavigateCommandSchema = closedObject({
  kind: Type.Literal("navigate"),
  sessionKey: NonEmptyString,
});

// Annotation targets are semantic UI identities, never executable selectors or HTML.
export const UiAnnotationSchema = closedObject({
  target: Type.Union([
    closedObject({
      control: Type.Union([
        Type.Literal("side-panel"),
        Type.Literal("panel-new"),
        Type.Literal("terminal-new"),
        Type.Literal("settings"),
        Type.Literal("agent-menu"),
        Type.Literal("agent-new"),
        Type.Literal("session-new"),
      ]),
    }),
    closedObject({ sessionKey: Type.String({ minLength: 1, maxLength: 512 }) }),
    closedObject({ text: Type.String({ minLength: 1, maxLength: 200 }) }),
  ]),
  text: Type.String({ minLength: 1, maxLength: 200 }),
  style: Type.Optional(
    Type.Union([Type.Literal("arrow"), Type.Literal("outline"), Type.Literal("note")]),
  ),
  color: Type.Optional(
    Type.Union([Type.Literal("coral"), Type.Literal("teal"), Type.Literal("purple")]),
  ),
});
export const UiAnnotateCommandSchema = closedObject({
  kind: Type.Literal("annotate"),
  annotations: Type.Array(UiAnnotationSchema, { minItems: 1, maxItems: 4 }),
  durationSeconds: Type.Optional(Type.Integer({ minimum: 3, maximum: 120 })),
});
export const UiAnnotationsClearCommandSchema = closedObject({
  kind: Type.Literal("annotations-clear"),
});

export const UiCommandSchema = Type.Union([
  UiAnnotateCommandSchema,
  UiAnnotationsClearCommandSchema,
  UiSplitCommandSchema,
  UiClosePaneCommandSchema,
  UiFocusCommandSchema,
  UiSidebarCommandSchema,
  UiPanelCommandSchema,
  UiNavigateCommandSchema,
]);
export type UiCommand = Static<typeof UiCommandSchema>;

export const UiCommandParamsSchema = closedObject({
  command: UiCommandSchema,
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
});
export type UiCommandParams = Static<typeof UiCommandParamsSchema>;

export const UiCommandResultSchema = closedObject({
  ok: Type.Boolean(),
  status: Type.Optional(Type.Literal("dispatched")),
});
export type UiCommandResult = Static<typeof UiCommandResultSchema>;
