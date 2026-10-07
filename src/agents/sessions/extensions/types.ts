/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

import type {
  AutocompleteItem,
  AutocompleteProvider,
  Component,
  EditorComponent,
  EditorTheme,
  KeyId,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";
import type { ImageContent, Model, TextContent } from "openclaw/plugin-sdk/llm";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type {
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  StreamFn,
  ThinkingLevel,
  ToolExecutionMode,
} from "../../runtime/index.js";
import type { BashResult } from "../bash-executor.js";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.js";
import type { EventBus } from "../event-bus.js";
import type { ExecOptions, ExecResult } from "../exec.js";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.js";
import type { KeybindingsManager } from "../keybindings.js";
import type { CustomMessage } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import type { ProviderConfig } from "../provider-config.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  ReadonlySessionManager,
  SessionEntry,
  SessionManager,
} from "../session-manager.js";
import type { SlashCommandInfo } from "../slash-commands.js";
import type { SourceInfo } from "../source-info.js";
import type { BuildSystemPromptOptions } from "../system-prompt-metadata.js";
import type { BashOperations } from "../tools/bash-operations.js";
import type {
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  EditToolInput,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  WriteToolInput,
} from "../tools/tool-contracts.js";

export type { ProviderConfig, OAuthLoginCallbacks } from "../provider-config.js";
export type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthPrompt,
  OAuthSelectOption,
  OAuthSelectPrompt,
} from "../../../plugin-sdk/provider-oauth-runtime.js";

interface ExtensionUIDialogOptions {
  /** AbortSignal to programmatically dismiss the dialog. */
  signal?: AbortSignal;
  /** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
  timeout?: number;
}

type WidgetPlacement = "aboveEditor" | "belowEditor";

interface ExtensionWidgetOptions {
  /** Where the widget is rendered. Defaults to "aboveEditor". */
  placement?: WidgetPlacement;
}

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Working indicator configuration for the interactive streaming loader. */
interface WorkingIndicatorOptions {
  /** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
  frames?: string[];
  /** Frame interval in milliseconds for animated indicators. */
  intervalMs?: number;
}

type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface ExtensionUIContext {
  select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;

  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;

  notify(message: string, type?: "info" | "warning" | "error"): void;

  /** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
  onTerminalInput(handler: TerminalInputHandler): () => void;

  /** Set status text in the footer/status bar. Pass undefined to clear. */
  setStatus(key: string, text: string | undefined): void;

  /** Set the working/loading message shown during streaming. Call with no argument to restore default. */
  setWorkingMessage(message?: string): void;

  /** Show or hide the built-in interactive working loader row during streaming. */
  setWorkingVisible(visible: boolean): void;

  /**
   * Configure the interactive working indicator shown during streaming.
   *
   * - Omit the argument to restore the default animated spinner.
   * - Use `frames: ["●"]` for a static indicator.
   * - Use `frames: []` to hide the indicator entirely.
   * - Custom frames are rendered as provided, so extensions must add their own colors.
   */
  setWorkingIndicator(options?: WorkingIndicatorOptions): void;

  /** Set the label shown for hidden thinking blocks. Call with no argument to restore default. */
  setHiddenThinkingLabel(label?: string): void;

  /** Set a widget to display above or below the editor. Accepts string array or component factory. */
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setWidget(
    key: string,
    content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
    options?: ExtensionWidgetOptions,
  ): void;

  /** Set a custom footer component, or undefined to restore the built-in footer.
   *
   * The factory receives a FooterDataProvider for data not otherwise accessible:
   * git branch and extension statuses from setStatus(). Token stats, model info,
   * etc. are available via ctx.sessionManager and ctx.model.
   */
  setFooter(
    factory:
      | ((
          tui: TUI,
          theme: Theme,
          footerData: ReadonlyFooterDataProvider,
        ) => Component & { dispose?(): void })
      | undefined,
  ): void;

  /** Set a custom header component (shown at startup, above chat), or undefined to restore the built-in header. */
  setHeader(
    factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
  ): void;

  /** Set the terminal window/tab title. */
  setTitle(title: string): void;

  /** Show a custom component with keyboard focus. */
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      /** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      /** Called with the overlay handle after the overlay is shown. Use to control visibility. */
      onHandle?: (handle: OverlayHandle) => void;
    },
  ): Promise<T>;

  /** Paste text into the editor, triggering paste handling (collapse for large content). */
  pasteToEditor(text: string): void;

  setEditorText(text: string): void;

  getEditorText(): string;

  /** Show a multi-line editor for text editing. */
  editor(title: string, prefill?: string): Promise<string | undefined>;

  /** Stack additional autocomplete behavior on top of the built-in provider. */
  addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

  /**
   * Set a custom editor component via factory function.
   * Pass undefined to restore the default editor.
   *
   * The factory receives:
   * - `theme`: EditorTheme for styling borders and autocomplete
   * - `keybindings`: KeybindingsManager for app-level keybindings
   *
   * For full app keybinding support (escape, ctrl+d, model switching, etc.),
   * extend `CustomEditor` from `openclaw/plugin-sdk/agent-sessions` and call
   * `super.handleInput(data)` for keys you don't handle.
   *
   * @example
   * ```ts
   * import { CustomEditor } from "openclaw/plugin-sdk/agent-sessions";
   *
   * class VimEditor extends CustomEditor {
   *   private mode: "normal" | "insert" = "insert";
   *
   *   handleInput(data: string): void {
   *     if (this.mode === "normal") {
   *       // Handle vim normal mode keys...
   *       if (data === "i") { this.mode = "insert"; return; }
   *     }
   *     super.handleInput(data);  // App keybindings + text editing
   *   }
   * }
   *
   * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
   *   new VimEditor(tui, theme, keybindings)
   * );
   * ```
   */
  setEditorComponent(factory: EditorFactory | undefined): void;

  /** Get the currently configured custom editor factory, or undefined when using the default editor. */
  getEditorComponent(): EditorFactory | undefined;

  readonly theme: Theme;

  getAllThemes(): { name: string; path: string | undefined }[];

  /** Load a theme by name without switching to it. Returns undefined if not found. */
  getTheme(name: string): Theme | undefined;

  setTheme(theme: string | Theme): { success: boolean; error?: string };

  getToolsExpanded(): boolean;

  setToolsExpanded(expanded: boolean): void;
}

export interface ContextUsage {
  /** Estimated context tokens, or null if any (e.g. right after compaction, before next LLM response). */
  tokens: number | null;
  contextWindow: number;
  /** Context usage as percentage of context window, or null if tokens is unknown. */
  percent: number | null;
}

export interface CompactOptions {
  customInstructions?: string;
  onComplete?: (result: CompactionResult) => void;
  onError?: (error: Error) => void;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  /** Whether UI is available (false in print/RPC mode) */
  hasUI: boolean;
  cwd: string;
  sessionManager: ReadonlySessionManager;
  /** Model registry for API key resolution */
  modelRegistry: ModelRegistry;
  model: Model | undefined;
  /** Whether the agent is idle (not streaming) */
  isIdle(): boolean;
  /** The current abort signal, or undefined when the agent is not streaming. */
  signal: AbortSignal | undefined;
  abort(): void;
  hasPendingMessages(): boolean;
  /** Gracefully shut down OpenClaw and exit. Available in all contexts. */
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  /** Trigger compaction without awaiting completion. */
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
export interface ExtensionCommandContext extends ExtensionContext {
  /** Wait for the agent to finish streaming */
  waitForIdle(): Promise<void>;

  /** Start a new session, optionally with initialization. */
  newSession(options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;

  /** Fork from a specific entry, creating a new session file. */
  fork(
    entryId: string,
    options?: {
      position?: "before" | "at";
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    },
  ): Promise<{ cancelled: boolean }>;

  /** Navigate to a different point in the session tree. */
  navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{ cancelled: boolean }>;

  /** Switch to a different session file. */
  switchSession(
    sessionPath: string,
    options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;

  /** Reload extensions, skills, prompts, and themes. */
  reload(): Promise<void>;
}

/**
 * Fresh command-capable context bound to the replacement session after a session switch.
 *
 * This is passed to `withSession()` callbacks on `newSession()`, `fork()`, and `switchSession()`.
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>;

  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void>;
}

export interface ToolRenderResultOptions {
  expanded: boolean;
  /** Whether this is a partial/streaming result */
  isPartial: boolean;
}

export interface ToolRenderContext<
  TState = unknown,
  TArgs = unknown,
> extends ToolRenderResultOptions {
  /** Current tool call arguments. Shared across call/result renders for the same tool call. */
  args: TArgs;
  /** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
  toolCallId: string;
  /** Invalidate just this tool execution component for redraw. */
  invalidate: () => void;
  /** Previously returned component for this render slot, if any. */
  lastComponent: Component | undefined;
  /** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  /** Whether the tool result is partial/streaming. */
  isPartial: boolean;
  expanded: boolean;
  /** Whether inline images are currently shown in the TUI. */
  showImages: boolean;
  isError: boolean;
}

type BivariantCallback<TArgs extends unknown[], TResult> = {
  bivarianceHack(...args: TArgs): TResult;
}["bivarianceHack"];

export interface ToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
> extends Pick<
  AgentTool<TParams, TDetails>,
  | "name"
  | "label"
  | "hideFromChannelProgress"
  | "resultContentSource"
  | "description"
  | "parameters"
  | "outputSchema"
  | "prepareArguments"
> {
  /** Optional one-line snippet for the Available tools section in the default system prompt. Custom tools are omitted from that section when this is not provided. */
  promptSnippet?: string;
  /** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
  promptGuidelines?: string[];
  /** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
  renderShell?: "default" | "self";
  executionMode?: ToolExecutionMode;

  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;

  renderCall?: BivariantCallback<
    [args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>],
    Component
  >;

  renderResult?: BivariantCallback<
    [
      result: AgentToolResult<TDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: ToolRenderContext<TState, Static<TParams>>,
    ],
    Component
  >;
}

type AnyToolDefinition = ToolDefinition;

/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Use this when assigning a tool to a variable or passing it through arrays such
 * as `customTools`, where contextual typing would otherwise widen params to
 * `unknown`.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
  return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

/** Fired when a session is started, loaded, or reloaded */
export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  /** Previously active session file. Present for "new", "resume", and "fork". */
  previousSessionFile?: string;
}

/** Fired before switching to another session (can be cancelled) */
interface SessionBeforeSwitchEvent {
  type: "session_before_switch";
  reason: "new" | "resume";
  targetSessionFile?: string;
}

/** Fired before forking a session (can be cancelled) */
interface SessionBeforeForkEvent {
  type: "session_before_fork";
  entryId: string;
  position: "before" | "at";
}

/** Fired before context compaction (can be cancelled or customized) */
interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  signal: AbortSignal;
  /** Prepared reasoning level for extension-owned summarization. */
  thinkingLevel?: ThinkingLevel;
  /** Prepared provider stream for extension-owned summarization. */
  streamFn?: StreamFn;
}

/** Fired after context compaction */
interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: CompactionEntry;
  fromExtension: boolean;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  /** Destination session file when shutting down due to session replacement. */
  targetSessionFile?: string;
}

export interface TreePreparation {
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  customInstructions?: string;
  /** If true, customInstructions replaces the default prompt instead of being appended */
  replaceInstructions?: boolean;
  /** Label to attach to the branch summary entry */
  label?: string;
}

/** Fired before navigating in the session tree (can be cancelled) */
interface SessionBeforeTreeEvent {
  type: "session_before_tree";
  preparation: TreePreparation;
  signal: AbortSignal;
}

/** Fired after navigating in the session tree */
interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string | null;
  oldLeafId: string | null;
  summaryEntry?: BranchSummaryEntry;
  fromExtension?: boolean;
}

type SessionEvent =
  | SessionStartEvent
  | SessionBeforeSwitchEvent
  | SessionBeforeForkEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent
  | SessionShutdownEvent
  | SessionBeforeTreeEvent
  | SessionTreeEvent;

/** Fired before each LLM call. Can modify messages. */
export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  payload: unknown;
}

/** Fired after a provider response is received and before the response stream is consumed. */
interface AfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string>;
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  /** The raw user prompt text (after expansion). */
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
  /** Structured options used to build the system prompt. Extensions can inspect this without re-discovering resources. */
  systemPromptOptions: BuildSystemPromptOptions;
}

type RuntimeAgentEvent<Type extends AgentEvent["type"]> = Extract<AgentEvent, { type: Type }>;

interface AgentStartEvent extends RuntimeAgentEvent<"agent_start"> {}

interface AgentEndEvent extends RuntimeAgentEvent<"agent_end"> {}

/** Fired once the session has no automatic retry, compaction, or queued continuation left. */
interface AgentSettledEvent {
  type: "agent_settled";
}

export interface TurnStartEvent extends RuntimeAgentEvent<"turn_start"> {
  turnIndex: number;
  timestamp: number;
}

export interface TurnEndEvent extends RuntimeAgentEvent<"turn_end"> {
  turnIndex: number;
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent extends RuntimeAgentEvent<"message_start"> {}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent extends RuntimeAgentEvent<"message_update"> {}

export interface MessageEndEvent extends RuntimeAgentEvent<"message_end"> {}

export interface ToolExecutionStartEvent extends Omit<
  RuntimeAgentEvent<"tool_execution_start">,
  "hideFromChannelProgress"
> {}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent extends Omit<
  RuntimeAgentEvent<"tool_execution_update">,
  "hideFromChannelProgress"
> {}

export interface ToolExecutionEndEvent extends Omit<
  RuntimeAgentEvent<"tool_execution_end">,
  "assistantTurnId" | "executionStarted" | "errorKind" | "hideFromChannelProgress"
> {}

type ModelSelectSource = "set" | "cycle" | "restore";

interface ModelSelectEvent {
  type: "model_select";
  model: Model;
  previousModel: Model | undefined;
  source: ModelSelectSource;
}

export interface ThinkingLevelSelectEvent {
  type: "thinking_level_select";
  level: ThinkingLevel;
  previousLevel: ThinkingLevel;
}

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
  type: "user_bash";
  command: string;
  /** True if !! prefix was used (excluded from LLM context) */
  excludeFromContext: boolean;
  cwd: string;
}

export type InputSource = "interactive" | "rpc" | "extension";

/** Fired when user input is received, before agent processing */
export interface InputEvent {
  type: "input";
  text: string;
  images?: ImageContent[];
  source: InputSource;
}

export type InputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: ImageContent[] }
  | { action: "handled" };

interface ToolCallEventBase<TName extends string, TInput> {
  type: "tool_call";
  toolCallId: string;
  toolName: TName;
  input: TInput;
}

type BashToolCallEvent = ToolCallEventBase<"bash", BashToolInput>;
type ReadToolCallEvent = ToolCallEventBase<"read", ReadToolInput>;
type EditToolCallEvent = ToolCallEventBase<"edit", EditToolInput>;
type WriteToolCallEvent = ToolCallEventBase<"write", WriteToolInput>;
type GrepToolCallEvent = ToolCallEventBase<"grep", GrepToolInput>;
type FindToolCallEvent = ToolCallEventBase<"find", FindToolInput>;
type LsToolCallEvent = ToolCallEventBase<"ls", LsToolInput>;
type CustomToolCallEvent = ToolCallEventBase<string, Record<string, unknown>>;

/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent =
  | BashToolCallEvent
  | ReadToolCallEvent
  | EditToolCallEvent
  | WriteToolCallEvent
  | GrepToolCallEvent
  | FindToolCallEvent
  | LsToolCallEvent
  | CustomToolCallEvent;

interface ToolResultEventBase<TName extends string, TDetails> {
  type: "tool_result";
  toolCallId: string;
  toolName: TName;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  details: TDetails;
  isError: boolean;
  terminate?: boolean;
}

type BashToolResultEvent = ToolResultEventBase<"bash", BashToolDetails | undefined>;
type ReadToolResultEvent = ToolResultEventBase<"read", ReadToolDetails | undefined>;
type EditToolResultEvent = ToolResultEventBase<"edit", EditToolDetails | undefined>;
type WriteToolResultEvent = ToolResultEventBase<"write", undefined>;
type GrepToolResultEvent = ToolResultEventBase<"grep", GrepToolDetails | undefined>;
type FindToolResultEvent = ToolResultEventBase<"find", FindToolDetails | undefined>;
type LsToolResultEvent = ToolResultEventBase<"ls", LsToolDetails | undefined>;
type CustomToolResultEvent = ToolResultEventBase<string, unknown>;

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent =
  | BashToolResultEvent
  | ReadToolResultEvent
  | EditToolResultEvent
  | WriteToolResultEvent
  | GrepToolResultEvent
  | FindToolResultEvent
  | LsToolResultEvent
  | CustomToolResultEvent;

export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
  return e.toolName === "bash";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
  return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
  return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
  return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
  return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
  return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
  return e.toolName === "ls";
}

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(
  toolName: "bash",
  event: ToolCallEvent,
): event is BashToolCallEvent;
export function isToolCallEventType(
  toolName: "read",
  event: ToolCallEvent,
): event is ReadToolCallEvent;
export function isToolCallEventType(
  toolName: "edit",
  event: ToolCallEvent,
): event is EditToolCallEvent;
export function isToolCallEventType(
  toolName: "write",
  event: ToolCallEvent,
): event is WriteToolCallEvent;
export function isToolCallEventType(
  toolName: "grep",
  event: ToolCallEvent,
): event is GrepToolCallEvent;
export function isToolCallEventType(
  toolName: "find",
  event: ToolCallEvent,
): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
  toolName: TName,
  event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
  return event.toolName === toolName;
}

export type ExtensionEvent =
  | ResourcesDiscoverEvent
  | SessionEvent
  | ContextEvent
  | BeforeProviderRequestEvent
  | AfterProviderResponseEvent
  | BeforeAgentStartEvent
  | AgentStartEvent
  | AgentEndEvent
  | AgentSettledEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | ModelSelectEvent
  | ThinkingLevelSelectEvent
  | UserBashEvent
  | InputEvent
  | ToolCallEvent
  | ToolResultEvent;

export interface ContextEventResult {
  messages?: AgentMessage[];
}

export interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean;
  reason?: string;
}

export interface UserBashEventResult {
  /** Custom operations to use for execution */
  operations?: BashOperations;
  /** Full replacement: extension handled execution, use this result */
  result?: BashResult;
}

export interface ToolResultEventResult extends AfterToolCallResult {}

export interface MessageEndEventResult {
  /** Replace the finalized message. The replacement must keep the original message role. */
  message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  /** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
  systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
  cancel?: boolean;
}

export interface SessionBeforeForkResult {
  cancel?: boolean;
  skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
  cancel?: boolean;
  summary?: {
    summary: string;
    details?: unknown;
  };
  /** Override custom instructions for summarization */
  customInstructions?: string;
  /** Override whether customInstructions replaces the default prompt */
  replaceInstructions?: boolean;
  /** Override label to attach to the branch summary entry */
  label?: string;
}

interface MessageRenderOptions {
  expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
  message: CustomMessage<T>,
  options: MessageRenderOptions,
  theme: Theme,
) => Component | undefined;

export interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
  invocationName: string;
}

// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

export interface ExtensionAPI {
  on(
    event: "resources_discover",
    handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>,
  ): void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(
    event: "session_before_switch",
    handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
  ): void;
  on(
    event: "session_before_fork",
    handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>,
  ): void;
  on(
    event: "session_before_compact",
    handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
  ): void;
  on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
  on(
    event: "session_before_tree",
    handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>,
  ): void;
  on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(
    event: "before_provider_request",
    handler: ExtensionHandler<BeforeProviderRequestEvent, unknown>,
  ): void;
  on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
  on(
    event: "before_agent_start",
    handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
  ): void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
  on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
  on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
  on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
  on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
  on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
  on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
  on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
  on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
  on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void;

  registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

  registerShortcut(
    shortcut: KeyId,
    options: Omit<ExtensionShortcut, "shortcut" | "extensionPath">,
  ): void;

  registerFlag(name: string, options: Omit<ExtensionFlag, "name" | "extensionPath">): void;

  getFlag(name: string): boolean | string | undefined;

  /** Register a custom renderer for CustomMessageEntry. */
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

  /** Send a custom message to the session. */
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;

  /**
   * Send a user message to the agent. Always triggers a turn.
   * When the agent is streaming, use deliverAs to specify how to queue the message.
   */
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;

  /** @deprecated Use appendEntryAsync; removed at the next Plugin SDK major. */
  appendEntry(customType: string, data?: unknown): void;

  /** Persist a custom entry and return its id after the worker commits. */
  appendEntryAsync(customType: string, data?: unknown): Promise<string>;

  /** @deprecated Use setSessionNameAsync; removed at the next Plugin SDK major. */
  setSessionName(name: string): void;

  /** Set the display name and publish the change after the worker commits. */
  setSessionNameAsync(name: string): Promise<void>;

  getSessionName(): string | undefined;

  /** @deprecated Use setLabelAsync; removed at the next Plugin SDK major. */
  setLabel(entryId: string, label: string | undefined): void;

  /** Set or clear an entry label after the worker commits. */
  setLabelAsync(entryId: string, label: string | undefined): Promise<void>;

  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

  getActiveTools(): string[];

  /** Get all configured tools with parameter schema and source metadata. */
  getAllTools(): ToolInfo[];

  setActiveTools(toolNames: string[]): void;

  /** Get available slash commands in the current session. */
  getCommands(): SlashCommandInfo[];

  /** Set the current model. Returns false if no API key available. */
  setModel(model: Model): Promise<boolean>;

  getThinkingLevel(): ThinkingLevel;

  /** Set thinking level (clamped to model capabilities). */
  setThinkingLevel(level: ThinkingLevel): Promise<void>;

  /**
   * Register a model provider.
   *
   * If `models` is provided: replaces all existing models for this provider.
   * If `oauth` is provided: registers OAuth provider for /login support.
   * If `streamSimple` is provided: registers a custom API stream handler.
   *
   * During initial extension load this call is queued and applied once the
   * runner has bound its context. After that it takes effect immediately, so
   * it is safe to call from command handlers or event callbacks without
   * requiring a `/reload`.
   *
   * @example
   * // Register a new provider with custom models
   * api.registerProvider("my-proxy", {
   *   baseUrl: "https://proxy.example.com",
   *   apiKey: "PROXY_API_KEY",
   *   api: "anthropic-messages",
   *   models: [
   *     {
   *       id: "claude-sonnet-4-20250514",
   *       name: "Claude 4 Sonnet (proxy)",
   *       reasoning: false,
   *       input: ["text", "image"],
   *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
   *       contextWindow: 200000,
   *       maxTokens: 16384
   *     }
   *   ]
   * });
   *
   * @example
   * // Override baseUrl for an existing provider
   * api.registerProvider("anthropic", {
   *   baseUrl: "https://proxy.example.com"
   * });
   *
   * @example
   * // Register provider with OAuth support
   * api.registerProvider("corporate-ai", {
   *   baseUrl: "https://ai.corp.com",
   *   api: "openai-responses",
   *   models: [...],
   *   oauth: {
   *     name: "Corporate AI (SSO)",
   *     async login(callbacks) { ... },
   *     async refreshToken(credentials) { ... },
   *     getApiKey(credentials) { return credentials.access; }
   *   }
   * });
   */
  registerProvider(name: string, config: ProviderConfig): void;

  /**
   * Unregister a previously registered provider.
   *
   * Removes all models belonging to the named provider and reloads the configured
   * model registry. Has no effect if the provider is not currently registered.
   *
   * Like `registerProvider`, this takes effect immediately when called after
   * the initial load phase.
   *
   * @example
   * api.unregisterProvider("my-proxy");
   */
  unregisterProvider(name: string): void;

  /** Shared event bus for extension communication. */
  events: EventBus;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface RegisteredTool {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
  name: string;
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
  extensionPath: string;
}

export interface ExtensionShortcut {
  shortcut: KeyId;
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
  extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SetSessionNameHandler = ExtensionAPI["setSessionName"];
export type GetSessionNameHandler = ExtensionAPI["getSessionName"];
export type RefreshToolsHandler = () => void;

export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & {
  sourceInfo: SourceInfo;
};

/**
 * Shared state created by loader, used during registration and runtime.
 * Contains flag values (defaults set during registration, CLI values set after).
 */
export interface ExtensionRuntimeState {
  flagValues: Map<string, boolean | string>;
  /** Provider registrations queued during extension loading, processed when runner binds */
  pendingProviderRegistrations: Array<{
    name: string;
    config: ProviderConfig;
    extensionPath: string;
  }>;
  /** Throws when this extension instance is stale after runtime replacement. */
  assertActive: () => void;
  /** Marks this extension instance as stale after runtime replacement or reload. */
  invalidate: (message?: string) => void;
  /**
   * Register or unregister a provider.
   *
   * Before bindCore(): queues registrations / removes from queue.
   * After bindCore(): calls ModelRegistry directly for immediate effect.
   */
  registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
  unregisterProvider: (name: string, extensionPath?: string) => void;
}

/**
 * Action implementations for ExtensionAPI methods.
 * Provided to runner.initialize(), copied into the shared runtime.
 */
export interface ExtensionActions extends Pick<
  ExtensionAPI,
  | "sendMessage"
  | "sendUserMessage"
  | "appendEntry"
  | "setSessionName"
  | "getSessionName"
  | "setLabel"
  | "getActiveTools"
  | "getAllTools"
  | "setActiveTools"
  | "getCommands"
  | "setModel"
  | "getThinkingLevel"
  | "setThinkingLevel"
> {
  refreshTools: RefreshToolsHandler;
}

/** Host actions with required worker-backed persistence capabilities. */
export interface ExtensionActionsV2
  extends
    ExtensionActions,
    Pick<ExtensionAPI, "appendEntryAsync" | "setSessionNameAsync" | "setLabelAsync"> {}

/** Actions for the live extension context, supplied by each runtime mode. */
export interface ExtensionContextActions extends Pick<
  ExtensionContext,
  | "isIdle"
  | "abort"
  | "hasPendingMessages"
  | "shutdown"
  | "getContextUsage"
  | "compact"
  | "getSystemPrompt"
> {
  getModel: () => ExtensionContext["model"];
  getSignal: () => ExtensionContext["signal"];
}

/** Session controls provided by modes that support extension commands. */
export interface ExtensionCommandContextActions extends Pick<
  ExtensionCommandContext,
  "waitForIdle" | "newSession" | "fork" | "navigateTree" | "switchSession" | "reload"
> {}

/**
 * Full runtime = state + actions.
 * Created by loader with throwing action stubs, completed by runner.initialize().
 */
export interface ExtensionRuntime
  extends
    ExtensionRuntimeState,
    ExtensionActions,
    Partial<
      Pick<ExtensionActionsV2, "appendEntryAsync" | "setSessionNameAsync" | "setLabelAsync">
    > {}

/** Host runtime with required worker-backed persistence capabilities. */
export interface ExtensionRuntimeV2 extends ExtensionRuntimeState, ExtensionActionsV2 {}

/** Loaded extension with all registered items. */
export interface Extension {
  path: string;
  resolvedPath: string;
  sourceInfo: SourceInfo;
  handlers: Map<string, HandlerFn[]>;
  tools: Map<string, RegisteredTool>;
  messageRenderers: Map<string, MessageRenderer>;
  commands: Map<string, RegisteredCommand>;
  flags: Map<string, ExtensionFlag>;
  shortcuts: Map<KeyId, ExtensionShortcut>;
}

export interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  /** Shared runtime - actions are throwing stubs until runner.initialize() */
  runtime: ExtensionRuntime;
}

export interface ExtensionError {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
