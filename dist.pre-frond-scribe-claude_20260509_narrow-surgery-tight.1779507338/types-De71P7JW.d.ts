import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { n as FailoverReason } from "./types-DKoVBm0H.js";
import { c as HookExternalContentSource } from "./external-content-BpqxkZzw.js";

//#region src/cron/types-shared.d.ts
type CronJobBase<TSchedule, TSessionTarget, TWakeMode, TPayload, TDelivery, TFailureAlert> = {
  id: string;
  agentId?: string;
  sessionKey?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: TSchedule;
  sessionTarget: TSessionTarget;
  wakeMode: TWakeMode;
  payload: TPayload;
  delivery?: TDelivery;
  failureAlert?: TFailureAlert;
};
//#endregion
//#region src/cron/types.d.ts
type CronSchedule = {
  kind: "at";
  at: string;
} | {
  kind: "every";
  everyMs: number;
  anchorMs?: number;
} | {
  kind: "cron";
  expr: string;
  tz?: string; /** Optional deterministic stagger window in milliseconds (0 keeps exact schedule). */
  staggerMs?: number;
};
type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;
type CronWakeMode = "next-heartbeat" | "now";
type CronMessageChannel = ChannelId;
type CronDeliveryMode = "none" | "announce" | "webhook";
type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string; /** Explicit thread/topic id for channels that support threaded delivery. */
  threadId?: string | number; /** Explicit channel account id for multi-account setups (e.g. multiple Telegram bots). */
  accountId?: string;
  bestEffort?: boolean; /** Separate destination for failure notifications. */
  failureDestination?: CronFailureDestination;
};
type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};
type CronDeliveryPatch = Partial<CronDelivery>;
type CronRunStatus = "ok" | "error" | "skipped";
type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";
type CronRunDiagnosticSeverity = "info" | "warn" | "error";
type CronRunDiagnosticSource = "cron-preflight" | "cron-setup" | "model-preflight" | "agent-run" | "tool" | "exec" | "delivery";
type CronRunDiagnostic = {
  ts: number;
  source: CronRunDiagnosticSource;
  severity: CronRunDiagnosticSeverity;
  message: string;
  toolName?: string;
  exitCode?: number | null;
  truncated?: boolean;
};
type CronRunDiagnostics = {
  summary?: string;
  entries: CronRunDiagnostic[];
};
type CronFailureAlert = {
  after?: number;
  channel?: CronMessageChannel;
  to?: string;
  cooldownMs?: number; /** When true, consecutive skipped runs count toward the alert threshold. */
  includeSkipped?: boolean; /** Delivery mode: announce (via messaging channels) or webhook (HTTP POST). */
  mode?: "announce" | "webhook"; /** Account ID for multi-account channel configurations. */
  accountId?: string;
};
type CronPayload = {
  kind: "systemEvent";
  text: string;
} | CronAgentTurnPayload;
type CronPayloadPatch = {
  kind: "systemEvent";
  text?: string;
} | CronAgentTurnPayloadPatch;
type CronAgentTurnPayloadFields = {
  message: string; /** Optional model override (provider/model or alias). */
  model?: string; /** Optional per-job fallback models; overrides agent/global fallbacks when defined. */
  fallbacks?: string[];
  thinking?: string;
  timeoutSeconds?: number;
  allowUnsafeExternalContent?: boolean; /** Immutable external hook provenance for async dispatch. */
  externalContentSource?: HookExternalContentSource; /** If true, run with lightweight bootstrap context. */
  lightContext?: boolean; /** Optional tool allow-list; when set, only these tools are sent to the model. */
  toolsAllow?: string[];
};
type CronAgentTurnPayload = {
  kind: "agentTurn";
} & CronAgentTurnPayloadFields;
type CronAgentTurnPayloadPatch = {
  kind: "agentTurn";
} & Partial<Omit<CronAgentTurnPayloadFields, "toolsAllow">> & {
  toolsAllow?: string[] | null;
};
type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number; /** Preferred execution outcome field. */
  lastRunStatus?: CronRunStatus; /** @deprecated Use lastRunStatus. */
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDiagnostics?: CronRunDiagnostics;
  lastDiagnosticSummary?: string; /** Classified reason for the last error (when available). */
  lastErrorReason?: FailoverReason;
  lastDurationMs?: number; /** Number of consecutive execution errors (reset on success). Used for backoff. */
  consecutiveErrors?: number; /** Number of consecutive skipped executions (reset on success or error). */
  consecutiveSkipped?: number; /** Last failure alert timestamp (ms since epoch) for cooldown gating. */
  lastFailureAlertAtMs?: number; /** Number of consecutive schedule computation errors. Auto-disables job after threshold. */
  scheduleErrorCount?: number; /** Explicit delivery outcome, separate from execution outcome. */
  lastDeliveryStatus?: CronDeliveryStatus; /** Delivery-specific error text when available. */
  lastDeliveryError?: string; /** Whether the last run's output was delivered to the target channel. */
  lastDelivered?: boolean; /** Whether the last failed run's failure notification was delivered to the target channel. */
  lastFailureNotificationDelivered?: boolean; /** Delivery outcome for the last failed run's failure notification. */
  lastFailureNotificationDeliveryStatus?: CronDeliveryStatus; /** Delivery-specific error for the last failed run's failure notification. */
  lastFailureNotificationDeliveryError?: string;
};
type CronJob = CronJobBase<CronSchedule, CronSessionTarget, CronWakeMode, CronPayload, CronDelivery, CronFailureAlert | false> & {
  state: CronJobState;
};
type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};
type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};
type CronJobPatch = Partial<Omit<CronJob, "id" | "createdAtMs" | "state" | "payload">> & {
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  state?: Partial<CronJobState>;
};
//#endregion
export { CronStoreFile as i, CronJobCreate as n, CronJobPatch as r, CronJob as t };