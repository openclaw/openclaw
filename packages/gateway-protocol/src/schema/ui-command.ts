import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const UiSplitCommandSchema = closedObject({
  kind: Type.Literal("split"),
  direction: stringLiteralUnion(["right", "down"]),
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
  expanded: Type.Optional(Type.Boolean()),
  dock: Type.Optional(stringLiteralUnion(["bottom", "right"])),
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
export const UiAgentGitHubSettingsCommandSchema = closedObject({
  kind: Type.Literal("agent-github-settings"),
});

export const UiCommandSchema = Type.Union([
  UiSplitCommandSchema,
  UiClosePaneCommandSchema,
  UiFocusCommandSchema,
  UiSidebarCommandSchema,
  UiPanelCommandSchema,
  UiNavigateCommandSchema,
  UiAgentGitHubSettingsCommandSchema,
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
  status: stringLiteralUnion(["blocked", "unverified", "new-tab-required"]),
  reason: stringLiteralUnion([
    "remote-ingress-required",
    "network-unreachable",
    "new-tab-required",
    "network-reachable",
    "probe-blocked",
    "portal-unavailable",
    "access-required",
    "waiting-for-app",
    "client-timeout",
    "client-disconnected",
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
