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

export const UiCommandSchema = Type.Union([
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
  /** Server-assigned correlation for requester-browser presentation feedback. */
  requestId: Type.Optional(NonEmptyString),
});
export type UiCommandParams = Static<typeof UiCommandParamsSchema>;

export const UiPortalPresentationSchema = closedObject({
  portalId: Type.Optional(NonEmptyString),
  status: Type.Union([
    Type.Literal("blocked"),
    Type.Literal("unverified"),
    Type.Literal("new-tab-required"),
  ]),
  reason: Type.Union([
    Type.Literal("remote-ingress-required"),
    Type.Literal("network-unreachable"),
    Type.Literal("new-tab-required"),
    Type.Literal("network-reachable"),
    Type.Literal("probe-blocked"),
    Type.Literal("portal-unavailable"),
    Type.Literal("access-required"),
    Type.Literal("waiting-for-app"),
    Type.Literal("client-timeout"),
    Type.Literal("client-disconnected"),
  ]),
});
export type UiPortalPresentation = Static<typeof UiPortalPresentationSchema>;

export const UiCommandReportParamsSchema = closedObject({
  requestId: NonEmptyString,
  presentation: UiPortalPresentationSchema,
});
export type UiCommandReportParams = Static<typeof UiCommandReportParamsSchema>;

export const UiCommandResultSchema = closedObject({
  ok: Type.Boolean(),
  delivery: Type.Optional(Type.Literal("dispatched")),
  presentation: Type.Optional(UiPortalPresentationSchema),
});
export type UiCommandResult = Static<typeof UiCommandResultSchema>;
