import type { ChatType } from "../channels/chat-type.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecMode } from "../infra/exec-approvals.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import type { AgentRunClientContext, AgentRunMessageContext } from "./command/shared-types.js";
import type { PreparedPairedComputerUse } from "./computer-use-node-capabilities.js";
import type { ConversationRecallContext } from "./conversation-recall.types.js";
import type { ExecPolicyOverrides, ExecSessionDefaults } from "./exec-defaults.js";
import type { ModelAwareToolContext } from "./openclaw-tools.model-context.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { CronToolOptions } from "./tools/cron-tool.types.js";
import type { QuestionPromptDelivery } from "./tools/question-prompt-send.js";

/** Options shared by the coding-tool factory and its OpenClaw tool surface. */
export type OpenClawSharedToolsOptions = {
  /**
   * How this run shows a blocking question tool's prompt. Harnesses that run tools
   * through the embedded tool lifecycle reserve the prompt themselves and leave this
   * unset; harnesses that dispatch tools directly pass it so the question still
   * reaches the person being asked.
   */
  questionPrompt?: QuestionPromptDelivery;
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  /** Trusted platform-native conversation id for the active inbound turn. */
  nativeChannelId?: string;
  /** Producer-authored bare upload handles mapped to exact sandbox paths. */
  stagedMediaPaths?: ReadonlyMap<string, string>;
  /** Durable store key when it differs from the sandbox/policy session key. */
  runSessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /** One-shot local CLI runs release plugin-owned resources after their result. */
  oneShotCliRun?: boolean;
  runId?: string;
  computerTransport?: import("./tools/computer-tool.js").ComputerToolTransport | null;
  /** Current runtime directory used as the default project for follow-up suggestions. */
  cwd?: string;
  /**
   * Workspace directory to pass to spawned subagents for inheritance.
   * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
   * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
   * subagents inherit the real workspace path instead of the sandbox copy.
   */
  spawnWorkspaceDir?: string;
  config?: OpenClawConfig;
  /** Gateway-owned session policy follows runtime updates; explicit overrides stay pinned. */
  sessionConfigSource?: "runtime" | "pinned";
  /** Host-bound history/search scope; does not change mutation or execution identity. */
  sessionReadScopeKey?: string;
  /**
   * Wrap returned tools with the before_tool_call hook at construction time.
   * Defaults to true; callers that already enforce the hook at a later shared
   * boundary should opt out explicitly.
   */
  wrapBeforeToolCallHook?: boolean;
  /** Internal review-run restrictions and proposal provenance. */
  skillWorkshop?: SkillWorkshopRunOptions;
  webFetchHostnameAllowlistRef?: { value?: string[] };
  webSearchEnabled?: boolean;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Dynamic audio state for runs that can accept steered input after tool creation. */
  hasCurrentInboundAudio?: () => boolean;
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  runtimeToolAllowlist?: string[];
  /** Host-prepared proof that this exact session can request Gateway publication. */
  githubPublicationAvailable?: boolean;
  cronCreatorAuthorityUnavailableReason?: CronToolOptions["creatorAuthorityUnavailableReason"];
  /** Mutable model-context generation used to expire screenshot coordinate frames. */
  computerContextEpoch?: { value: number };
  /** Registers run-owned cleanup for tools that hold node resources. */
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
  inboundEventKind?: InboundEventKind;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  swarmCollector?: boolean;
  swarmOutputSchema?: Record<string, unknown>;
  /** If true, include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
  claimYieldCompletion?: () => boolean | Promise<boolean>;
  /** Records hot-path tool-prep stages for reply startup diagnostics. */
  recordToolPrepStage?: (name: string) => void;
};

export type OpenClawToolsOptions = {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: string;
  /** Host-bound standalone request/grant authority, never supplied by tool arguments. */
  assertInvocationCurrent?: () => void;
  /** Exact admitted session policy shared with terminal-input authorization. */
  execSession?: ExecSessionDefaults;
  /** Effective run-local exec overrides, including prepared permission mode. */
  execOverrides?: ExecPolicyOverrides & { mode?: ExecMode };
  /** Trusted operator devices allowed to review this run's terminal input. */
  approvalReviewerDeviceIds?: string[];
  /** Trusted account used for authorization; delivery keeps agentAccountId. */
  gatewayCallerAccountId?: string;
  gatewayCallerChannel?: string | null;
  /** True only for explicit server-authored local scheduled provenance. */
  gatewayCallerLocal?: boolean;
  /** True only for a validated scheduled tool policy. */
  gatewayCallerScheduled?: boolean;
  /** Delivery target for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Message-only authority from a CLI grant; does not authorize plugin delivery. */
  messageToolTurnCapability?: { token: string; sessionKey: string };
  /** Private factory admission for a new scheduled message invocation. */
  admitScheduledMessageInvocation?: () => OpenClawConfig;
  sandboxRoot?: string;
  sandboxContainerWorkdir?: string;
  sandboxFsBridge?: SandboxFsBridge;
  sandboxReadOnlyResourceMounts?: readonly { hostPath: string; containerPath: string }[];
  /** Prepared effective read authorization for exporting sandbox workspace media. */
  sandboxWorkspaceMediaReadAllowed?: boolean;
  fsPolicy?: ToolFsPolicy;
  sandboxed?: boolean;
  pluginToolAllowlist?: string[];
  pluginToolDenylist?: string[];
  /** Prepared profile authority for the gateway tool's configuration-read actions. */
  gatewayConfigReadAllowed?: boolean;
  /** Effective caller tool surface to persist on isolated cron agentTurn jobs. */
  cronCreatorToolAllowlist?: CronToolOptions["creatorToolAllowlist"];
  cronCreatorToolAllowlistCaptureRef?: CronToolOptions["creatorToolAllowlistCaptureRef"];
  resolveCronCreatorToolAuthority?: CronToolOptions["resolveCreatorToolAuthority"];
  /** Trusted normalized conversation kind for the active inbound turn. */
  currentChatType?: ChatType;
  /** Fail closed instead of posting same-channel thread-originated replies at the root. */
  sameChannelThreadRequired?: boolean;
  pairedNodeComputerUse?: PreparedPairedComputerUse;
  /** If true, nodes action="invoke" can call media-returning commands directly. */
  allowMediaInvokeCommands?: boolean;
  /** Server-owned operation-local origin for conversation-read visibility policy. */
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  /** Restrict cron operations to the active cron job's self-scoped surface. */
  cronSelfRemoveOnlyJobId?: string;
  /** Process-local completion authority restricted to the current source conversation. */
  sourceReplyOnly?: boolean;
  /**
   * Re-checked immediately before a collector result is persisted. Supplied by
   * callers whose collector authority can be revoked while a tool call is
   * already in flight.
   */
  assertCollectorWriteAuthority?: () => void;
  /** If true, skip plugin tool resolution and return only shipped core tools. */
  disablePluginTools?: boolean;
  /** Override or extend the default hook context used by construction-time wrapping. */
  beforeToolCallHookContext?: HookContext;
  /** Trusted sender id from inbound context (not tool args). */
  requesterSenderId?: string | null;
  /** Prepared exec/process isolation key for this run. */
  processScopeKey?: string;
} & OpenClawSharedToolsOptions &
  AgentRunClientContext &
  AgentRunMessageContext &
  SpawnedToolContext &
  ModelAwareToolContext;
