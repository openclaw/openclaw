import { t as ChatType } from "./chat-type-BtX_XjMF.js";
import { _n as TtsAutoMode } from "./types.channels-C67UBRPK.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { o as ChannelRouteRef } from "./channel-route-BCPDrLfB.js";
import { t as DeliveryContext } from "./delivery-context.types-DsJXWtUi.js";
import { Skill } from "@earendil-works/pi-coding-agent";

//#region src/config/sessions/types.d.ts
type SessionScope = "per-sender" | "global";
type SessionChannelId = ChannelId;
type SessionChatType = ChatType;
type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  accountId?: string;
  threadId?: string | number;
};
type SessionAcpIdentitySource = "ensure" | "status" | "event";
type SessionAcpIdentityState = "pending" | "resolved";
type SessionAcpIdentity = {
  state: SessionAcpIdentityState;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  source: SessionAcpIdentitySource;
  lastUpdatedAt: number;
};
type SessionAcpMeta = {
  backend: string;
  agent: string;
  runtimeSessionName: string;
  identity?: SessionAcpIdentity;
  mode: "persistent" | "oneshot";
  runtimeOptions?: AcpSessionRuntimeOptions;
  cwd?: string;
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
};
type AcpSessionRuntimeOptions = {
  /**
   * ACP runtime mode set via session/set_mode (for example: "plan", "normal", "auto").
   */
  runtimeMode?: string; /** ACP runtime config option: model id. */
  model?: string; /** ACP runtime config option: thinking/reasoning effort. */
  thinking?: string; /** Working directory override for ACP session turns. */
  cwd?: string; /** ACP runtime config option: permission profile id. */
  permissionProfile?: string; /** ACP runtime config option: per-turn timeout in seconds. */
  timeoutSeconds?: number; /** Backend-specific option bag mapped through session/set_config_option. */
  backendExtras?: Record<string, string>;
};
type CliSessionBinding = {
  sessionId: string; /** Trust an explicitly attached CLI session even when auth, prompt, or MCP fingerprints drift. */
  forceReuse?: boolean;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion?: number;
  extraSystemPromptHash?: string;
  promptToolNamesHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
};
type SessionCompactionCheckpointReason = "manual" | "auto-threshold" | "overflow-retry" | "timeout-retry";
type SessionCompactionTranscriptReference = {
  sessionId: string;
  sessionFile?: string;
  leafId?: string;
  entryId?: string;
};
type SessionCompactionCheckpoint = {
  checkpointId: string;
  sessionKey: string;
  sessionId: string;
  createdAt: number;
  reason: SessionCompactionCheckpointReason;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
  firstKeptEntryId?: string;
  preCompaction: SessionCompactionTranscriptReference;
  postCompaction: SessionCompactionTranscriptReference;
};
type SessionPluginDebugEntry = {
  pluginId: string;
  lines: string[];
};
type SessionPluginJsonValue = string | number | boolean | null | SessionPluginJsonValue[] | {
  [key: string]: SessionPluginJsonValue;
};
type SessionPluginNextTurnInjection = {
  id: string;
  pluginId: string;
  pluginName?: string;
  text: string;
  idempotencyKey?: string;
  placement: "prepend_context" | "append_context";
  ttlMs?: number;
  createdAt: number;
  metadata?: SessionPluginJsonValue;
};
type SubagentRecoveryState = {
  /** Consecutive accepted automatic orphan-recovery resumes in the rapid re-wedge window. */automaticAttempts?: number; /** Timestamp (ms) of the latest accepted automatic orphan-recovery resume. */
  lastAttemptAt?: number; /** Registry run id that triggered the latest automatic orphan-recovery resume. */
  lastRunId?: string; /** Timestamp (ms) when automatic recovery was tombstoned for this session. */
  wedgedAt?: number; /** Human-readable reason automatic recovery was tombstoned. */
  wedgedReason?: string;
};
type LaneExecutionState = "active" | "draining" | "suspended" | "resuming" | "circuit_open" | "failed_handoff";
interface QuotaSuspension {
  schemaVersion: 1;
  suspendedAt: number;
  reason: "quota_exhausted" | "manual" | "circuit_open";
  failedProvider: string;
  failedModel: string;
  /** Recovery briefing text injected into the next attempt when state === "resuming". */
  summary?: string;
  /** Opaque pointer to an external snapshot blob (path/key); not the briefing text itself. */
  snapshotRef?: string;
  /** Lane that was set to concurrency=0 when this suspension was issued. */
  laneId?: string;
  expectedResumeBy?: number;
  state: LaneExecutionState;
}
type SessionEntry = {
  /**
   * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
   * Stored on the main session entry.
   */
  lastHeartbeatText?: string; /** Timestamp (ms) when lastHeartbeatText was delivered. */
  lastHeartbeatSentAt?: number;
  /**
   * Base session key for heartbeat-created isolated sessions.
   * When present, `<base>:heartbeat` is a synthetic isolated session rather than
   * a real user/session-scoped key that merely happens to end with `:heartbeat`.
   */
  heartbeatIsolatedBaseSessionKey?: string; /** Heartbeat task state (task name -> last run timestamp ms). */
  heartbeatTaskState?: Record<string, number>; /** Plugin-owned session state, grouped by plugin id then extension namespace. */
  pluginExtensions?: Record<string, Record<string, SessionPluginJsonValue>>; /** Top-level SessionEntry mirror slots owned by plugin session extensions. */
  pluginExtensionSlotKeys?: Record<string, Record<string, string>>; /** Durable one-shot prompt additions drained before the next agent turn. */
  pluginNextTurnInjections?: Record<string, SessionPluginNextTurnInjection[]>;
  sessionId: string;
  updatedAt: number;
  sessionFile?: string; /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string; /** Workspace inherited by spawned sessions and reused on later turns for the same child session. */
  spawnedWorkspaceDir?: string; /** Explicit parent session linkage for dashboard-created child sessions. */
  parentSessionKey?: string; /** True after a thread/topic session has been forked from its parent transcript once. */
  forkedFromParent?: boolean; /** Subagent spawn depth (0 = main, 1 = sub-agent, 2 = sub-sub-agent). */
  spawnDepth?: number; /** Explicit role assigned at spawn time for subagent tool policy/control decisions. */
  subagentRole?: "orchestrator" | "leaf"; /** Explicit control scope assigned at spawn time for subagent control decisions. */
  subagentControlScope?: "children" | "none"; /** Session-scoped tool deny entries inherited from the caller that created this session. */
  inheritedToolDeny?: string[]; /** Session-scoped tool allow entries inherited from the caller that created this session. */
  inheritedToolAllow?: string[]; /** Plugin id that created this session through api.runtime.subagent. */
  pluginOwnerId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean; /** Durable guard state for automatic subagent orphan recovery. */
  subagentRecovery?: SubagentRecoveryState; /** Quota cascade protection and state-aware failover status. */
  quotaSuspension?: QuotaSuspension; /** Timestamp (ms) when the current sessionId first became active. */
  sessionStartedAt?: number; /** Stable usage lineage key for transcript-backed rollups across sessionId rotations. */
  usageFamilyKey?: string; /** Session ids known to belong to this usage lineage, including archived predecessors. */
  usageFamilySessionIds?: string[]; /** Timestamp (ms) of the last user/channel interaction that should extend idle lifetime. */
  lastInteractionAt?: number; /** Stable first-run start time for subagent sessions, persisted after completion. */
  startedAt?: number; /** Latest completed run end time for subagent sessions, persisted after completion. */
  endedAt?: number; /** Accumulated runtime across subagent follow-up runs, persisted after completion. */
  runtimeMs?: number; /** Final persisted subagent run status, used after in-memory run archival. */
  status?: "running" | "done" | "failed" | "killed" | "timeout";
  /**
   * Session-level stop cutoff captured when /stop is received.
   * Messages at/before this boundary are skipped to avoid replaying
   * queued pre-stop backlog.
   */
  abortCutoffMessageSid?: string; /** Epoch ms cutoff paired with abortCutoffMessageSid when available. */
  abortCutoffTimestamp?: number;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode; /** Hash of the latest assistant reply that was sent through `/tts latest`. */
  lastTtsReadLatestHash?: string; /** Timestamp (ms) when `/tts latest` last sent audio for this session. */
  lastTtsReadLatestAt?: number;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string; /** Session-scoped agent runtime/harness override selected with the model picker. */
  agentRuntimeOverride?: string;
  /**
   * Tracks whether the persisted model override came from an explicit user
   * action (`/model`, `sessions.patch`) or from a temporary runtime fallback.
   * Resets only preserve user-driven overrides.
   */
  modelOverrideSource?: "auto" | "user"; /** Selected model that produced the current auto fallback override. */
  modelOverrideFallbackOriginProvider?: string;
  modelOverrideFallbackOriginModel?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
  /**
   * Set on explicit user-driven session model changes (for example `/model`
   * and `sessions.patch`) during an active run. The embedded runner checks
   * this flag to decide whether to throw `LiveSessionModelSwitchError`.
   * System-initiated fallbacks (rate-limit retry rotation) never set this
   * flag, so they are never mistaken for user-initiated switches.
   */
  liveModelSwitchPending?: boolean;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?: "steer" | "followup" | "collect" | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number; /** Durable marker that final user reply delivery still needs a retry/resume pass. */
  pendingFinalDelivery?: boolean;
  pendingFinalDeliveryCreatedAt?: number;
  pendingFinalDeliveryLastAttemptAt?: number;
  pendingFinalDeliveryAttemptCount?: number;
  pendingFinalDeliveryLastError?: string | null; /** Frozen reply text that needs delivery. */
  pendingFinalDeliveryText?: string | null; /** Original delivery context (channel, recipient, etc). */
  pendingFinalDeliveryContext?: DeliveryContext; /** Durable send intent backing pending final delivery, when already created. */
  pendingFinalDeliveryIntentId?: string | null;
  /**
   * Whether totalTokens reflects a fresh context snapshot for the latest run.
   * Undefined means legacy/unknown freshness; false forces consumers to treat
   * totalTokens as stale/unknown for context-utilization displays.
   */
  totalTokensFresh?: boolean;
  estimatedCostUsd?: number;
  cacheRead?: number;
  cacheWrite?: number;
  modelProvider?: string;
  model?: string;
  /**
   * Embedded agent harness selected for this session id.
   * Prevents config/env changes from moving an existing transcript between
   * incompatible runtime harnesses.
   */
  agentHarnessId?: string;
  /**
   * Last selected/runtime model pair for which a fallback notice was emitted.
   * Used to avoid repeating the same fallback notice every turn.
   */
  fallbackNoticeSelectedModel?: string;
  fallbackNoticeActiveModel?: string;
  fallbackNoticeReason?: string;
  contextTokens?: number;
  compactionCount?: number;
  compactionCheckpoints?: SessionCompactionCheckpoint[];
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  memoryFlushContextHash?: string;
  cliSessionIds?: Record<string, string>;
  cliSessionBindings?: Record<string, CliSessionBinding>;
  claudeCliSessionId?: string;
  label?: string;
  displayName?: string;
  channel?: string;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: SessionOrigin;
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  skillsSnapshot?: SessionSkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
  /**
   * Generic plugin-owned runtime debug entries shown in verbose status surfaces.
   * Each plugin owns and may overwrite only its own entry between turns.
   */
  pluginDebugEntries?: SessionPluginDebugEntry[];
  acp?: SessionAcpMeta;
};
type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};
type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{
    name: string;
    primaryEnv?: string;
    requiredEnv?: string[];
  }>; /** Normalized agent-level filter used to build this snapshot; undefined means unrestricted. */
  skillFilter?: string[];
  /**
   * Runtime-only, never persisted. Carries the full parsed Skill[] (including
   * each SKILL.md body) so the embedded runner can skip a workspace skill
   * scan within a turn. Stripped from sessions.json on every read and write
   * via normalizeSessionStore — see store-load.ts. On a cold session resume
   * this is undefined and src/agents/pi-embedded-runner/skills-runtime.ts
   * rebuilds it by reloading skill entries from disk.
   */
  resolvedSkills?: Skill[];
  version?: number;
};
type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: {
    warningMode?: "off" | "once" | "always";
    warningShown?: boolean;
    promptWarningSignature?: string;
    warningSignaturesSeen?: string[];
    truncatedFiles?: number;
    nearLimitFiles?: number;
    totalNearLimit?: boolean;
  };
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  currentTurn?: {
    kind?: "user_request" | "room_event";
    promptChars: number;
    runtimeContextChars: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  skills: {
    promptChars: number;
    entries: Array<{
      name: string;
      blockChars: number;
    }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount?: number | null;
    }>;
  };
};
//#endregion
export { SessionAcpMeta as a, SessionSystemPromptReport as c, SessionAcpIdentity as i, CliSessionBinding as n, SessionEntry as o, GroupKeyResolution as r, SessionScope as s, AcpSessionRuntimeOptions as t };