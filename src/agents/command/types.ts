import type { AgentInternalEvent } from "../../agents/internal-events.js";
import type { ClientToolDefinition } from "../../agents/pi-embedded-runner/run/params.js";
import type { SpawnedRunMetadata } from "../../agents/spawned-context.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";

/** Image content block for Claude API multimodal messages. */
export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type AgentStreamParams = {
  /** Provider stream params override (best-effort). */
  temperature?: number;
  maxTokens?: number;
  /** Provider fast-mode override (best-effort). */
  fastMode?: boolean;
};

export type AgentRunContext = {
  messageChannel?: string;
  accountId?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
};

export type AgentCommandOpts = {
  message: string;
  /** Optional image attachments for multimodal messages. */
  images?: ImageContent[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Agent id override (must exist in config). */
  agentId?: string;
  /** Per-run provider override. */
  provider?: string;
  /** Per-run model override. */
  model?: string;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  /** Internal replay metadata for no-miss inbound recovery. */
  sourceMessageId?: string;
  /** Internal replay metadata for no-miss inbound recovery. */
  inboundReceiptId?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  /** Override delivery target (separate from session routing). */
  replyTo?: string;
  /** Override delivery channel (separate from session routing). */
  replyChannel?: string;
  /** Override delivery account id (separate from session routing). */
  replyAccountId?: string;
  /** Override delivery thread/topic id (separate from session routing). */
  threadId?: string | number;
  /** Message channel context (webchat|voicewake|whatsapp|...). */
  messageChannel?: string;
  channel?: string; // delivery channel (whatsapp|telegram|...)
  /** Account ID for multi-account channel routing (e.g., WhatsApp account). */
  accountId?: string;
  /** Context for embedded run routing (channel/account/thread). */
  runContext?: AgentRunContext;
  /** Whether this caller is authorized for owner-only tools (defaults true for local CLI calls). */
  senderIsOwner?: boolean;
  /** Whether this caller is authorized to use provider/model per-run overrides. */
  allowModelOverride?: boolean;
  /** Group/spawn metadata for subagent policy inheritance and routing context. */
  groupId?: SpawnedRunMetadata["groupId"];
  groupChannel?: SpawnedRunMetadata["groupChannel"];
  groupSpace?: SpawnedRunMetadata["groupSpace"];
  spawnedBy?: SpawnedRunMetadata["spawnedBy"];
  deliveryTargetMode?: ChannelOutboundTargetMode;
  bestEffortDeliver?: boolean;
  abortSignal?: AbortSignal;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  /** Per-call stream param overrides (best-effort). */
  streamParams?: AgentStreamParams;
  /** Explicit workspace directory override (for subagents to inherit parent workspace). */
  workspaceDir?: SpawnedRunMetadata["workspaceDir"];
  /** Reuse an existing chief task instead of creating a new tracked task. */
  matchedTaskId?: string;
  /** Explicit Paperclip issue binding for tracked work. */
  paperclipIssueId?: string;
  /** Stable thread key used by continuity evaluation. */
  threadKey?: string;
  /** Stable normalized intent key used for task continuity. */
  openIntentKey?: string;
  /** Short tracked-work intent summary. */
  intentSummary?: string;
  /** Short current goal summary for the tracked task. */
  currentGoal?: string;
  /** Stable parent program id for the tracked task graph. */
  programId?: string;
  /** Optional parent task id inside the tracked work graph. */
  parentTaskId?: string;
  /** Role that chief or a worker is fulfilling for this turn. */
  role?: string;
  /** Explicit success criteria for the tracked task. */
  successCriteria?: string;
  /** Evidence gathered for verification and release gating. */
  verificationEvidence?: string[];
  /** Risk level chief currently assigns to the task. */
  riskLevel?: "low" | "medium" | "high" | "critical";
  /** Confidence score from continuity/intake evaluation. */
  confidence?: number;
  /** Latest milestone summary for progress heartbeat reporting. */
  latestMilestone?: string;
  /** Timestamp of the last user-visible progress report. */
  lastUserProgressReportAt?: number;
  /** Current release gate state for this tracked task. */
  releaseGateStatus?: "not_required" | "required" | "reviewing" | "passed" | "blocked";
  /** Structured continuity decision for this run. */
  continuityDecision?: "direct_answer" | "attach_existing_task" | "new_task_candidate";
  /** True when tracked work was created only after explicit user approval. */
  createdByApproval?: boolean;
  /** Controls whether this run should update the chief tracked-task ledger. */
  chiefTaskTrackingMode?: "tracked" | "skip";
};

export type AgentCommandIngressOpts = Omit<
  AgentCommandOpts,
  "senderIsOwner" | "allowModelOverride"
> & {
  /** Ingress callsites must always pass explicit owner-tool authorization state. */
  senderIsOwner: boolean;
  /** Ingress callsites must always pass explicit model-override authorization state. */
  allowModelOverride: boolean;
};
