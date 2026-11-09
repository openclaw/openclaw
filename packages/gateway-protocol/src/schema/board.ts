import type { Static } from "typebox";
import { Type } from "typebox";
import { WIDGET_HTML_MAX_UTF8_BYTES } from "./canvas.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const BoardTabIdSchema = Type.String({ pattern: "^[a-z0-9-]{1,40}$" });
export const BoardWidgetNameSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
});
export const BoardWidgetGeneratedIdentitySchema = closedObject({
  source: Type.Literal("show_widget"),
  key: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  fallbackName: BoardWidgetNameSchema,
});
export type BoardWidgetGeneratedIdentity = Static<typeof BoardWidgetGeneratedIdentitySchema>;
export const BoardWidgetPluginKindSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$",
});
export const BoardWidgetPluginPropsSchema = Type.Record(Type.String(), Type.Unknown());
export const BoardChatDockSchema = Type.Union([
  Type.Literal("left"),
  Type.Literal("right"),
  Type.Literal("bottom"),
  Type.Literal("hidden"),
]);
export const BoardSizeSchema = Type.Union([
  Type.Literal("sm"),
  Type.Literal("md"),
  Type.Literal("lg"),
  Type.Literal("xl"),
  Type.Literal("full"),
]);
export const BoardWidgetPresentationSchema = Type.Union([
  Type.Literal("card"),
  Type.Literal("full-bleed"),
  Type.Literal("frameless"),
]);
export const BoardWidgetHeightModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("fixed"),
]);

export const BOARD_CRON_JOB_ID_MAX_LENGTH = 256;
export const BOARD_CRON_TRIGGER_PREFIX = "cron.trigger:";
export const BOARD_WIDGET_TOOL_MAX_LENGTH =
  BOARD_CRON_TRIGGER_PREFIX.length + BOARD_CRON_JOB_ID_MAX_LENGTH;
export const BOARD_DATA_BINDING_ID_MAX_LENGTH = 64;

export const BoardTabSchema = closedObject({
  tabId: BoardTabIdSchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  position: Type.Integer({ minimum: 0 }),
  chatDock: BoardChatDockSchema,
});
export type BoardTab = Static<typeof BoardTabSchema>;

export const BOARD_GITHUB_ACTIONS_QUERY_FIELDS = [
  "total_count",
  "id",
  "name",
  "display_title",
  "head_branch",
  "status",
  "conclusion",
  "html_url",
  "run_started_at",
  "created_at",
  "updated_at",
  "event",
  "workflow_id",
  "run_attempt",
] as const;
export const BoardWidgetDataQuerySchema = closedObject({
  name: BoardWidgetNameSchema,
  bindingId: Type.Literal("github.actions.runs"),
  params: closedObject({
    repository: Type.String({ minLength: 1, maxLength: 140 }),
    workflow: Type.Union([
      Type.String({ minLength: 1, maxLength: 255 }),
      Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
    branch: Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()]),
    status: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
    created: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
    perPage: Type.Integer({ minimum: 1, maximum: 30 }),
    excludePullRequests: Type.Boolean(),
  }),
  fields: Type.Array(Type.Enum(BOARD_GITHUB_ACTIONS_QUERY_FIELDS), { minItems: 1, maxItems: 14 }),
});
export type BoardWidgetDataQuery = Static<typeof BoardWidgetDataQuerySchema>;

export const BoardWidgetActionBindingSchema = closedObject({
  name: BoardWidgetNameSchema,
  actionId: Type.String({ minLength: 1, maxLength: BOARD_WIDGET_TOOL_MAX_LENGTH }),
  params: Type.Record(
    Type.String({ minLength: 1, maxLength: 80 }),
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    { maxProperties: 32 },
  ),
});
export type BoardWidgetActionBinding = Static<typeof BoardWidgetActionBindingSchema>;

export const BoardWidgetDeclaredSchema = closedObject({
  netOrigins: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: BOARD_WIDGET_TOOL_MAX_LENGTH }), {
      maxItems: 64,
    }),
  ),
  actionBindings: Type.Optional(Type.Array(BoardWidgetActionBindingSchema, { maxItems: 16 })),
  queries: Type.Optional(
    Type.Array(BoardWidgetDataQuerySchema, {
      maxItems: 8,
      description:
        "Named live GitHub Actions queries shared with session readers using the agent's credentials. Fix every selector, result limit, and response field; use null explicitly for all workflows/branches or no filter. Changed definitions require renewed approval. For saved summaries, use session:report instead.",
    }),
  ),
});
export type BoardWidgetDeclared = Static<typeof BoardWidgetDeclaredSchema>;

export const BoardWidgetSchema = closedObject({
  name: BoardWidgetNameSchema,
  /** Stable across edits; regenerated after removal/recreation. Never a permission grant. */
  componentId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$" })),
  tabId: BoardTabIdSchema,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  description: Type.Optional(Type.String({ maxLength: 240 })),
  contentKind: Type.Union([Type.Literal("html"), Type.Literal("mcp-app"), Type.Literal("plugin")]),
  contentOwner: Type.Optional(
    Type.Enum(["html", "mcp-app", "plugin", "registered"] as const, { type: "string" }),
  ),
  // Read-only v4 metadata from older Gateways; new stores never emit registered content.
  registeredContentKind: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" })),
  pluginKind: Type.Optional(BoardWidgetPluginKindSchema),
  props: Type.Optional(BoardWidgetPluginPropsSchema),
  presentation: Type.Optional(BoardWidgetPresentationSchema),
  heightMode: Type.Optional(BoardWidgetHeightModeSchema),
  sizeW: Type.Integer({ minimum: 1, maximum: 12 }),
  sizeH: Type.Integer({ minimum: 1, maximum: 20 }),
  position: Type.Integer({ minimum: 0 }),
  grantState: Type.Union([
    Type.Literal("none"),
    Type.Literal("pending"),
    Type.Literal("granted"),
    Type.Literal("rejected"),
  ]),
  revision: Type.Integer({ minimum: 1 }),
  instanceId: Type.Optional(NonEmptyString),
  declaredSummary: Type.Optional(Type.Array(Type.String())),
  /** Current plugin-owned descriptions for consent UI, never persisted or used as authority. */
  capabilityDescriptions: Type.Optional(Type.Record(Type.String(), Type.String())),
  declared: Type.Optional(BoardWidgetDeclaredSchema),
  frameUrl: Type.Optional(Type.String()),
  viewTicket: Type.Optional(Type.String()),
  viewTicketTtlMs: Type.Optional(Type.Integer({ minimum: 1 })),
  viewGeneration: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$" })),
  sandboxUrl: Type.Optional(Type.String()),
  sandboxPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  sandboxOrigin: Type.Optional(Type.String()),
  kindLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});
export type BoardWidget = Static<typeof BoardWidgetSchema>;

const BoardSnapshotFields = {
  sessionKey: NonEmptyString,
  revision: Type.Integer({ minimum: 0 }),
  tabs: Type.Array(BoardTabSchema),
  widgets: Type.Array(BoardWidgetSchema),
};
export const BoardSnapshotSchema = closedObject(BoardSnapshotFields);
export type BoardSnapshot = Static<typeof BoardSnapshotSchema>;

export const BoardTabCreateOpSchema = closedObject({
  kind: Type.Literal("tab_create"),
  tabId: BoardTabIdSchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  chatDock: Type.Optional(BoardChatDockSchema),
});
export const BoardTabUpdateOpSchema = closedObject({
  kind: Type.Literal("tab_update"),
  tabId: BoardTabIdSchema,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  chatDock: Type.Optional(BoardChatDockSchema),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const BoardTabDeleteOpSchema = closedObject({
  kind: Type.Literal("tab_delete"),
  tabId: BoardTabIdSchema,
});
export const BoardTabsReorderOpSchema = closedObject({
  kind: Type.Literal("tabs_reorder"),
  tabIds: Type.Array(BoardTabIdSchema),
});
export const BoardWidgetMoveOpSchema = closedObject({
  kind: Type.Literal("widget_move"),
  name: BoardWidgetNameSchema,
  tabId: Type.Optional(BoardTabIdSchema),
  position: Type.Optional(Type.Integer({ minimum: 0 })),
  after: Type.Optional(BoardWidgetNameSchema),
});
export const BoardWidgetResizeOpSchema = closedObject({
  kind: Type.Literal("widget_resize"),
  name: BoardWidgetNameSchema,
  sizeW: Type.Integer(),
  sizeH: Type.Integer(),
  heightMode: Type.Optional(BoardWidgetHeightModeSchema),
});
export const BoardWidgetRemoveOpSchema = closedObject({
  kind: Type.Literal("widget_remove"),
  name: BoardWidgetNameSchema,
});
export const BoardOpSchema = Type.Union([
  BoardTabCreateOpSchema,
  BoardTabUpdateOpSchema,
  BoardTabDeleteOpSchema,
  BoardTabsReorderOpSchema,
  BoardWidgetMoveOpSchema,
  BoardWidgetResizeOpSchema,
  BoardWidgetRemoveOpSchema,
]);
export type BoardOp = Static<typeof BoardOpSchema>;

export const BoardComponentTargetSchema = closedObject({
  name: BoardWidgetNameSchema,
  id: Type.String({ pattern: "^[a-f0-9]{32}$" }),
});
export const BoardWidgetConversationParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  name: BoardWidgetNameSchema,
  instanceId: NonEmptyString,
});
export type BoardWidgetConversationParams = Static<typeof BoardWidgetConversationParamsSchema>;

export const BoardGetParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  component: Type.Optional(BoardComponentTargetSchema),
});
export type BoardGetParams = Static<typeof BoardGetParamsSchema>;

/** Source is inert text; offsets and lengths count JavaScript UTF-16 code units. */
export const BoardWidgetSourceParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  component: Type.Optional(BoardComponentTargetSchema),
  name: BoardWidgetNameSchema,
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: WIDGET_HTML_MAX_UTF8_BYTES })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_536 })),
});
export type BoardWidgetSourceParams = Static<typeof BoardWidgetSourceParamsSchema>;

export const BoardWidgetSourceResultSchema = closedObject({
  sessionKey: NonEmptyString,
  name: BoardWidgetNameSchema,
  revision: Type.Integer({ minimum: 1 }),
  sha256: NonEmptyString,
  html: Type.String(),
  offset: Type.Integer({ minimum: 0 }),
  totalLength: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type BoardWidgetSourceResult = Static<typeof BoardWidgetSourceResultSchema>;

export const BoardUpdateParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  component: Type.Optional(BoardComponentTargetSchema),
  ops: Type.Array(BoardOpSchema),
});
export type BoardUpdateParams = Static<typeof BoardUpdateParamsSchema>;

export const BoardMcpAppDescriptorSchema = closedObject({
  serverName: NonEmptyString,
  toolName: NonEmptyString,
  uiResourceUri: NonEmptyString,
  toolCallId: NonEmptyString,
});
export type BoardMcpAppDescriptor = Static<typeof BoardMcpAppDescriptorSchema>;

export const BoardWidgetHtmlContentSchema = closedObject({
  kind: Type.Literal("html"),
  html: Type.String({ maxLength: WIDGET_HTML_MAX_UTF8_BYTES }),
});
export const BoardWidgetMcpAppContentSchema = closedObject({
  kind: Type.Literal("mcp-app"),
  descriptor: BoardMcpAppDescriptorSchema,
});
export const BoardWidgetMcpAppPutContentSchema = closedObject({
  kind: Type.Literal("mcp-app"),
  viewId: NonEmptyString,
});
export const BoardWidgetPluginContentSchema = closedObject({
  kind: Type.Literal("plugin"),
  pluginKind: BoardWidgetPluginKindSchema,
  props: Type.Optional(BoardWidgetPluginPropsSchema),
});
// Keep retired v4 content wire-valid for older clients and Gateways. The put
// handler reports its removal; this is never materialized or rendered.
export const BoardWidgetRegisteredContentSchema = closedObject({
  kind: Type.Literal("registered"),
  contentKind: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
  source: Type.String({ maxLength: 262_144 }),
});
export const BoardWidgetContentSchema = Type.Union([
  BoardWidgetHtmlContentSchema,
  BoardWidgetMcpAppContentSchema,
  BoardWidgetPluginContentSchema,
  BoardWidgetRegisteredContentSchema,
]);
export type BoardWidgetContent = Static<typeof BoardWidgetContentSchema>;
export type BoardWidgetMaterializedContent =
  | Static<typeof BoardWidgetHtmlContentSchema>
  | (Static<typeof BoardWidgetMcpAppContentSchema> & { interactive: boolean })
  | Static<typeof BoardWidgetPluginContentSchema>;
export const BoardCanvasDocumentSourceSchema = closedObject({
  kind: Type.Literal("canvas-doc"),
  docId: NonEmptyString,
});
export type BoardCanvasDocumentSource = Static<typeof BoardCanvasDocumentSourceSchema>;

export const BoardWidgetPutContentSchema = Type.Union([
  BoardWidgetHtmlContentSchema,
  BoardWidgetMcpAppPutContentSchema,
  BoardWidgetPluginContentSchema,
  BoardWidgetRegisteredContentSchema,
  BoardCanvasDocumentSourceSchema,
]);
export type BoardWidgetPutContent = Static<typeof BoardWidgetPutContentSchema>;

export const BoardWidgetPutParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  component: Type.Optional(BoardComponentTargetSchema),
  name: BoardWidgetNameSchema,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  description: Type.Optional(Type.String({ maxLength: 240 })),
  content: BoardWidgetPutContentSchema,
  presentation: Type.Optional(BoardWidgetPresentationSchema),
  heightMode: Type.Optional(BoardWidgetHeightModeSchema),
  placement: Type.Optional(
    closedObject({
      tabId: Type.Optional(BoardTabIdSchema),
      size: Type.Optional(BoardSizeSchema),
      after: Type.Optional(BoardWidgetNameSchema),
    }),
  ),
  declared: Type.Optional(BoardWidgetDeclaredSchema),
  generatedIdentity: Type.Optional(BoardWidgetGeneratedIdentitySchema),
});
export type BoardWidgetPutParams = Static<typeof BoardWidgetPutParamsSchema>;
/** Materialized input accepted by the board store after gateway source resolution. */
export type BoardWidgetMaterializedPutParams = Omit<BoardWidgetPutParams, "content"> & {
  content: BoardWidgetMaterializedContent;
};
export const BoardWidgetPutResultSchema = closedObject({
  ...BoardSnapshotFields,
  resolvedWidgetName: BoardWidgetNameSchema,
});
export type BoardWidgetPutResult = Static<typeof BoardWidgetPutResultSchema>;

export const BoardWidgetGrantParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  name: BoardWidgetNameSchema,
  decision: Type.Union([Type.Literal("granted"), Type.Literal("rejected")]),
  revision: Type.Integer({ minimum: 1 }),
  instanceId: NonEmptyString,
});
export type BoardWidgetGrantParams = Static<typeof BoardWidgetGrantParamsSchema>;

export const BoardWidgetAppViewParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  name: BoardWidgetNameSchema,
  revision: Type.Integer({ minimum: 1 }),
  instanceId: NonEmptyString,
});
export type BoardWidgetAppViewParams = Static<typeof BoardWidgetAppViewParamsSchema>;

export const BoardWidgetAppViewResultSchema = closedObject({
  viewId: NonEmptyString,
  expiresAtMs: Type.Integer({ minimum: 0 }),
});
export type BoardWidgetAppViewResult = Static<typeof BoardWidgetAppViewResultSchema>;

export const BoardViewTicketSchema = Type.String({ minLength: 1, maxLength: 2048 });

export const BoardLegacyEventParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  widget: BoardWidgetNameSchema,
  payload: Type.Unknown(),
});
export const BoardTicketEventParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
  payload: Type.Unknown(),
});
export const BoardEventParamsSchema = Type.Union([
  BoardLegacyEventParamsSchema,
  BoardTicketEventParamsSchema,
]);
export type BoardEventParams = Static<typeof BoardEventParamsSchema>;

export const BoardPromptAuthorizeParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
});
export type BoardPromptAuthorizeParams = Static<typeof BoardPromptAuthorizeParamsSchema>;

export const BoardDataReadParamsSchema = Type.Union([
  closedObject({
    ticket: BoardViewTicketSchema,
    bindingId: Type.String({ minLength: 1, maxLength: BOARD_DATA_BINDING_ID_MAX_LENGTH }),
    params: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Unknown(), {
        maxProperties: 64,
      }),
    ),
  }),
  closedObject({
    ticket: BoardViewTicketSchema,
    queryName: BoardWidgetNameSchema,
  }),
]);
export type BoardDataReadParams = Static<typeof BoardDataReadParamsSchema>;

export const BoardCronActionParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
  action: Type.Literal("cron.trigger"),
  jobId: Type.String({ minLength: 1, maxLength: BOARD_CRON_JOB_ID_MAX_LENGTH }),
});
export const BoardPluginActionParamsSchema = closedObject({
  ticket: BoardViewTicketSchema,
  action: Type.String({ minLength: 1, maxLength: BOARD_WIDGET_TOOL_MAX_LENGTH }),
  params: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Unknown(), {
      maxProperties: 64,
    }),
  ),
});
export const BoardActionParamsSchema = Type.Union([
  BoardCronActionParamsSchema,
  BoardPluginActionParamsSchema,
  closedObject({
    ticket: BoardViewTicketSchema,
    bindingName: BoardWidgetNameSchema,
    params: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.Unknown(), {
        maxProperties: 64,
      }),
    ),
  }),
]);
export type BoardActionParams = Static<typeof BoardActionParamsSchema>;

export const BoardChangedEventSchema = closedObject({
  sessionKey: NonEmptyString,
  revision: Type.Integer({ minimum: 0 }),
  widget: Type.Optional(BoardWidgetNameSchema),
});
export type BoardChangedEvent = Static<typeof BoardChangedEventSchema>;

export const BoardFocusTabCommandSchema = closedObject({
  kind: Type.Literal("focus_tab"),
  tabId: BoardTabIdSchema,
});
export const BoardSetChatDockCommandSchema = closedObject({
  kind: Type.Literal("set_chat_dock"),
  dock: BoardChatDockSchema,
});
export const BoardCommandSchema = Type.Union([
  BoardFocusTabCommandSchema,
  BoardSetChatDockCommandSchema,
]);
export type BoardCommand = Static<typeof BoardCommandSchema>;

export const BoardCommandEventSchema = closedObject({
  sessionKey: NonEmptyString,
  command: BoardCommandSchema,
});
export type BoardCommandEvent = Static<typeof BoardCommandEventSchema>;
