import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type {
  AgentApprovalEventData,
  AgentCommandOutputEventData,
  AgentItemEventData,
  AgentPatchSummaryEventData,
} from "../infra/agent-events.js";
import {
  emitAgentApprovalEvent,
  emitAgentCommandOutputEvent,
  emitAgentEvent,
  emitAgentItemEvent,
  emitAgentPatchSummaryEvent,
  getAgentRunContext,
  type AgentApprovalPlanStep,
} from "../infra/agent-events.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type { PluginHookAfterToolCallEvent } from "../plugins/types.js";
import { normalizeOptionalLowercaseString, readStringValue } from "../shared/string-coerce.js";
import type { ApplyPatchSummary } from "./apply-patch.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { parseExecApprovalResultText } from "./exec-approval-result.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import { mergeEmbeddedRunReplayState } from "./pi-embedded-runner/replay-state.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";
import {
  extractToolResultMediaArtifact,
  extractMessagingToolSend,
  extractToolErrorMessage,
  extractToolResultText,
  filterToolResultMediaUrls,
  isToolResultError,
  isToolResultTimedOut,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { newPlanApprovalId } from "./plan-mode/index.js";
import { buildToolMutationState, isSameToolMutationAction } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";

type ExecApprovalReplyModule = typeof import("../infra/exec-approval-reply.js");
type HookRunnerGlobalModule = typeof import("../plugins/hook-runner-global.js");
type MediaParseModule = typeof import("../media/parse.js");
type BeforeToolCallModule = typeof import("./pi-tools.before-tool-call.js");
type SessionStoreRuntimeModule = typeof import("../config/sessions/store.runtime.js");
type ConfigModule = typeof import("../config/config.js");
type SessionPathsModule = typeof import("../config/sessions/paths.js");
type RoutingModule = typeof import("../routing/session-key.js");

let execApprovalReplyModulePromise: Promise<ExecApprovalReplyModule> | undefined;
let hookRunnerGlobalModulePromise: Promise<HookRunnerGlobalModule> | undefined;
let mediaParseModulePromise: Promise<MediaParseModule> | undefined;
let beforeToolCallModulePromise: Promise<BeforeToolCallModule> | undefined;
let sessionStoreRuntimePromise: Promise<SessionStoreRuntimeModule> | undefined;
let configModulePromise: Promise<ConfigModule> | undefined;
let sessionPathsPromise: Promise<SessionPathsModule> | undefined;
let routingPromise: Promise<RoutingModule> | undefined;

function loadExecApprovalReply(): Promise<ExecApprovalReplyModule> {
  execApprovalReplyModulePromise ??= import("../infra/exec-approval-reply.js");
  return execApprovalReplyModulePromise;
}

function loadHookRunnerGlobal(): Promise<HookRunnerGlobalModule> {
  hookRunnerGlobalModulePromise ??= import("../plugins/hook-runner-global.js");
  return hookRunnerGlobalModulePromise;
}

function loadMediaParse(): Promise<MediaParseModule> {
  mediaParseModulePromise ??= import("../media/parse.js");
  return mediaParseModulePromise;
}

function loadBeforeToolCall(): Promise<BeforeToolCallModule> {
  beforeToolCallModulePromise ??= import("./pi-tools.before-tool-call.js");
  return beforeToolCallModulePromise;
}

function loadSessionStoreRuntime(): Promise<SessionStoreRuntimeModule> {
  sessionStoreRuntimePromise ??= import("../config/sessions/store.runtime.js");
  return sessionStoreRuntimePromise;
}

function loadConfigModule(): Promise<ConfigModule> {
  configModulePromise ??= import("../config/config.js");
  return configModulePromise;
}

function loadSessionPaths(): Promise<SessionPathsModule> {
  sessionPathsPromise ??= import("../config/sessions/paths.js");
  return sessionPathsPromise;
}

function loadRouting(): Promise<RoutingModule> {
  routingPromise ??= import("../routing/session-key.js");
  return routingPromise;
}

/**
 * Persist plan-mode approval-pending state on the session entry so the
 * `sessions.patch { planApproval }` flow can match the approvalId minted
 * by the runtime when `exit_plan_mode` fires.
 *
 * Without this, the resolvePlanApproval guard rejects every approval
 * click as "stale approvalId" because the on-disk state has
 * `approvalId: undefined` while the UI sends the freshly-minted token.
 */
async function persistPlanApprovalRequest(
  sessionKey: string,
  approvalId: string,
  log: { warn?: (msg: string) => void } | undefined,
): Promise<void> {
  try {
    const [
      { updateSessionStoreEntry },
      { loadConfig },
      { resolveStorePath },
      { parseAgentSessionKey },
    ] = await Promise.all([
      loadSessionStoreRuntime(),
      loadConfigModule(),
      loadSessionPaths(),
      loadRouting(),
    ]);
    const cfg = loadConfig();
    const parsed = parseAgentSessionKey(sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    const now = Date.now();
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (entry) => {
        const current = entry.planMode;
        // No active plan-mode session — agent called exit_plan_mode
        // outside of plan mode (shouldn't happen in normal flow). Leave
        // the entry untouched so we don't accidentally arm the gate.
        if (!current || current.mode !== "plan") {
          return null;
        }
        return {
          planMode: {
            ...current,
            approval: "pending",
            approvalId,
            updatedAt: now,
          },
        };
      },
    });
  } catch (err) {
    log?.warn?.(`failed to persist plan-mode approvalId: ${String(err)}`);
  }
}

/**
 * Persist plan-mode entry on the session entry when the agent calls
 * `enter_plan_mode`. Without this the tool is a pure no-op — the agent
 * thinks it entered plan mode, the runtime never armed the gate, and
 * the agent's next turn sits idle because nothing changed.
 *
 * Gated on the same `agents.defaults.planMode.enabled` opt-in as the
 * user-driven path so the agent can't escape the operator's feature
 * flag.
 */
/**
 * Result of persisting a plan-mode-enter intercept.
 * - `freshEntry: true` means the session transitioned from
 *   normal/none → plan (caller should schedule new nudge crons).
 * - `freshEntry: false` means the session was ALREADY in plan mode
 *   and we just refreshed `updatedAt` — caller MUST NOT schedule
 *   additional nudges, otherwise `nudgeJobIds` would grow unbounded
 *   on repeated `enter_plan_mode` calls (PR-9 adversarial review #1).
 * - `ok: false` means the persist failed (gated off, IO error, etc.).
 */
type PersistPlanModeEnterResult = { ok: boolean; freshEntry: boolean };

async function persistPlanModeEnter(
  sessionKey: string,
  log: { warn?: (msg: string) => void } | undefined,
): Promise<PersistPlanModeEnterResult> {
  try {
    const [
      { updateSessionStoreEntry },
      { loadConfig },
      { resolveStorePath },
      { parseAgentSessionKey },
    ] = await Promise.all([
      loadSessionStoreRuntime(),
      loadConfigModule(),
      loadSessionPaths(),
      loadRouting(),
    ]);
    const cfg = loadConfig();
    if (cfg.agents?.defaults?.planMode?.enabled !== true) {
      // Feature gated off — refuse the transition. Agent will see the
      // tool succeed but no state change; the workspaceNotes / tool
      // description should explain plan mode is disabled.
      return { ok: false, freshEntry: false };
    }
    const parsed = parseAgentSessionKey(sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    const now = Date.now();
    let wasFreshEntry = false;
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (entry) => {
        const current = entry.planMode;
        if (current?.mode === "plan") {
          // Already in plan mode — refresh updatedAt only. NUDGES MUST
          // NOT be re-scheduled here (caller checks `freshEntry`),
          // otherwise repeated `enter_plan_mode` calls would append
          // unbounded entries to `nudgeJobIds`.
          wasFreshEntry = false;
          return {
            planMode: {
              ...current,
              updatedAt: now,
            },
          };
        }
        // Fresh entry: clear any stale rejection history, reset to a
        // clean pending-nothing state. Mirrors the sessions.patch
        // { planMode: "plan" } user-driven path.
        //
        // PR-10 auto-mode: preserve `autoApprove` across plan cycles.
        // The sessions-patch approve branch keeps the flag on `mode →
        // normal` transitions; without re-applying it here, the flag
        // would be lost on the very next enter_plan_mode call (since
        // entry.planMode.mode is "normal" at that point so we hit this
        // fresh-entry branch). Reading from `current` covers both
        // pre-armed (normal/none w/ autoApprove) and fresh (no entry).
        wasFreshEntry = true;
        const carryAutoApprove = current?.autoApprove === true;
        return {
          planMode: {
            mode: "plan",
            approval: "none",
            enteredAt: now,
            updatedAt: now,
            rejectionCount: 0,
            ...(carryAutoApprove ? { autoApprove: true } : {}),
          },
        };
      },
    });
    return { ok: true, freshEntry: wasFreshEntry };
  } catch (err) {
    log?.warn?.(`failed to persist plan-mode entry: ${String(err)}`);
    return { ok: false, freshEntry: false };
  }
}

/**
 * PR-10 auto-mode: if the session has `planMode.autoApprove === true`,
 * fire `sessions.patch { planApproval: { action: "approve", approvalId }}`
 * immediately so the plan executes without waiting for the user.
 *
 * Failure mode (review H1): if `callGatewayTool` throws (gateway
 * restart, network blip, schema rejection of the auto-approve patch),
 * the approval card stays on-screen for manual click and we log a
 * `error` (not `warn`) so the operator sees the silent fall-back.
 * The user-visible degradation is "auto-mode briefly behaves like
 * manual" — acceptable, but loud enough in the logs to debug.
 *
 * Reads the session entry directly so the toggle takes effect on the
 * very next plan submission (no agent-side state mirroring needed).
 *
 * Race window (review H2): we read the store via `readSessionStoreReadOnly`
 * (no lock). Between the read and the auto-approve patch, the user
 * could click "Reject" — we'd then over-approve. The mitigation is
 * that the approve and reject actions both go through `resolvePlanApproval`
 * with the same approvalId, so whichever lands LAST wins. Auto-approve
 * lands first in practice (it fires synchronously inside the tool-end
 * handler) so a user reject lands on `mode: normal, approval: none`
 * (terminal) and is cleanly rejected by the state-machine guard.
 */
async function autoApproveIfEnabled(params: {
  sessionKey: string;
  approvalId: string;
  log?: {
    warn?: (msg: string) => void;
    info?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}): Promise<void> {
  try {
    const [
      { loadConfig },
      { resolveStorePath },
      { parseAgentSessionKey },
      { readSessionStoreReadOnly },
    ] = await Promise.all([
      loadConfigModule(),
      loadSessionPaths(),
      loadRouting(),
      loadSessionStoreRead(),
    ]);
    const cfg = loadConfig();
    const parsed = parseAgentSessionKey(params.sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    const store = readSessionStoreReadOnly(storePath);
    const entry = store[params.sessionKey];
    if (!entry?.planMode?.autoApprove) {
      return; // not auto-mode; let the user resolve manually
    }
    const { callGatewayTool } = await import("./tools/gateway.js");
    await callGatewayTool(
      "sessions.patch",
      {},
      {
        key: params.sessionKey,
        planApproval: {
          action: "approve",
          approvalId: params.approvalId,
        },
      },
    );
    params.log?.info?.(
      `auto-mode: plan auto-approved sessionKey=${params.sessionKey} approvalId=${params.approvalId}`,
    );
  } catch (err) {
    // Use error-level logging instead of warn so operators notice the
    // silent fall-back. The user sees the approval card stay open and
    // can resolve it manually; auto-mode briefly degrades.
    (params.log?.error ?? params.log?.warn)?.(
      `auto-approve FAILED — approval card requires manual resolve. ` +
        `sessionKey=${params.sessionKey} approvalId=${params.approvalId}: ${String(err)}`,
    );
  }
}

let sessionStoreReadModulePromise:
  | Promise<typeof import("../config/sessions/store-read.js")>
  | undefined;
function loadSessionStoreRead(): Promise<typeof import("../config/sessions/store-read.js")> {
  sessionStoreReadModulePromise ??= import("../config/sessions/store-read.js");
  return sessionStoreReadModulePromise;
}

/**
 * PR-9 Wave B3: schedule plan-nudge wake-up crons after enter_plan_mode
 * succeeds, then persist the resulting job IDs onto
 * `SessionEntry.planMode.nudgeJobIds` so cleanup can target them
 * precisely when the plan resolves (sessions-patch.ts handles the
 * cleanup transition).
 *
 * Fire-and-forget from the caller — schedule failures are tolerated
 * (the plan still works without nudges; nudges are an augmentation).
 * Bounded retry / observability would land in a follow-up.
 */
async function schedulePlanNudgesAndPersist(params: {
  sessionKey: string;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}): Promise<void> {
  let createdJobIds: string[] = [];
  try {
    const { schedulePlanNudges } = await import("./plan-mode/plan-nudge-crons.js");
    const [
      { readSessionStoreReadOnly },
      { updateSessionStoreEntry },
      { loadConfig },
      { resolveStorePath },
      { parseAgentSessionKey },
    ] = await Promise.all([
      loadSessionStoreRead(),
      loadSessionStoreRuntime(),
      loadConfigModule(),
      loadSessionPaths(),
      loadRouting(),
    ]);
    const cfg = loadConfig();
    const parsed = parseAgentSessionKey(params.sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    const currentEntry = readSessionStoreReadOnly(storePath)[params.sessionKey];
    const planCycleId =
      currentEntry?.planMode?.mode === "plan" ? currentEntry.planMode.cycleId : undefined;
    const scheduled = await schedulePlanNudges({
      sessionKey: params.sessionKey,
      planCycleId,
      log: params.log,
    });
    if (scheduled.length === 0) {
      return;
    }
    const jobIds = scheduled.map((n) => n.jobId);
    createdJobIds = jobIds;
    let persisted = false;
    await updateSessionStoreEntry({
      storePath,
      sessionKey: params.sessionKey,
      update: async (entry) => {
        if (!entry.planMode || entry.planMode.mode !== "plan") {
          // Plan mode resolved between schedule + persist — drop the
          // ids on the floor; sessions-patch already cleaned them up
          // (or there's nothing to clean up).
          return null;
        }
        if (planCycleId && entry.planMode.cycleId !== planCycleId) {
          return null;
        }
        persisted = true;
        return {
          planMode: {
            ...entry.planMode,
            nudgeJobIds: [...(entry.planMode.nudgeJobIds ?? []), ...jobIds],
          },
        };
      },
    });
    if (!persisted) {
      const { cleanupPlanNudges } = await import("./plan-mode/plan-nudge-crons.js");
      await cleanupPlanNudges({ jobIds, log: params.log });
    }
  } catch (err) {
    if (createdJobIds.length > 0) {
      try {
        const { cleanupPlanNudges } = await import("./plan-mode/plan-nudge-crons.js");
        await cleanupPlanNudges({ jobIds: createdJobIds, log: params.log });
      } catch {
        // best-effort cleanup
      }
    }
    params.log?.warn?.(`schedulePlanNudgesAndPersist failed: ${String(err)}`);
  }
}

type ToolStartRecord = {
  startTime: number;
  args: unknown;
};

/** Track tool execution start data for after_tool_call hook. */
const toolStartData = new Map<string, ToolStartRecord>();

function buildToolStartKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

function isCronAddAction(args: unknown): boolean {
  if (!args || typeof args !== "object") {
    return false;
  }
  const action = (args as Record<string, unknown>).action;
  return normalizeOptionalLowercaseString(action) === "add";
}

function buildToolCallSummary(toolName: string, args: unknown, meta?: string): ToolCallSummary {
  const mutation = buildToolMutationState(toolName, args, meta);
  return {
    meta,
    mutatingAction: mutation.mutatingAction,
    actionFingerprint: mutation.actionFingerprint,
  };
}

function buildToolItemId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

function buildToolItemTitle(toolName: string, meta?: string): string {
  return meta ? `${toolName} ${meta}` : toolName;
}

function isExecToolName(toolName: string): boolean {
  return toolName === "exec" || toolName === "bash";
}

function isPatchToolName(toolName: string): boolean {
  return toolName === "apply_patch";
}

function buildCommandItemId(toolCallId: string): string {
  return `command:${toolCallId}`;
}

function buildPatchItemId(toolCallId: string): string {
  return `patch:${toolCallId}`;
}

function buildCommandItemTitle(toolName: string, meta?: string): string {
  return meta ? `command ${meta}` : `${toolName} command`;
}

function buildPatchItemTitle(meta?: string): string {
  return meta ? `patch ${meta}` : "apply patch";
}

function emitTrackedItemEvent(ctx: ToolHandlerContext, itemData: AgentItemEventData): void {
  if (itemData.phase === "start") {
    ctx.state.itemActiveIds.add(itemData.itemId);
    ctx.state.itemStartedCount += 1;
  } else if (itemData.phase === "end") {
    ctx.state.itemActiveIds.delete(itemData.itemId);
    ctx.state.itemCompletedCount += 1;
  }
  emitAgentItemEvent({
    runId: ctx.params.runId,
    ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
    data: itemData,
  });
  void ctx.params.onAgentEvent?.({
    stream: "item",
    data: itemData,
  });
}

function readToolResultDetailsRecord(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

function readExecToolDetails(result: unknown): ExecToolDetails | null {
  const details = readToolResultDetailsRecord(result);
  if (!details || typeof details.status !== "string") {
    return null;
  }
  return details as ExecToolDetails;
}

function readApplyPatchSummary(result: unknown): ApplyPatchSummary | null {
  const details = readToolResultDetailsRecord(result);
  const summary =
    details?.summary && typeof details.summary === "object" && !Array.isArray(details.summary)
      ? (details.summary as Record<string, unknown>)
      : null;
  if (!summary) {
    return null;
  }
  const added = Array.isArray(summary.added)
    ? summary.added.filter((entry): entry is string => typeof entry === "string")
    : [];
  const modified = Array.isArray(summary.modified)
    ? summary.modified.filter((entry): entry is string => typeof entry === "string")
    : [];
  const deleted = Array.isArray(summary.deleted)
    ? summary.deleted.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { added, modified, deleted };
}

/**
 * Reads the `exit_plan_mode` tool result into a typed plan-proposal
 * shape suitable for the approval event payload (PR-8 follow-up).
 * Returns null if the tool result doesn't carry a plan (e.g. tool
 * raised before producing one).
 */
function readPlanProposalDetails(result: unknown): {
  plan: AgentApprovalPlanStep[];
  summary?: string;
  title?: string;
  analysis?: string;
  assumptions?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  verification?: string[];
  references?: string[];
} | null {
  const details = readToolResultDetailsRecord(result);
  if (!details || details.status !== "approval_requested") {
    return null;
  }
  const rawPlan = details.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const plan: AgentApprovalPlanStep[] = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const step = (entry as Record<string, unknown>).step;
    const status = (entry as Record<string, unknown>).status;
    const activeForm = (entry as Record<string, unknown>).activeForm;
    // PR-10 review fix (Greptile P1 #3105250277): the archetype prompt
    // tells agents to include `acceptanceCriteria: [...]` on high-risk
    // steps so the closure-gate prevents premature `status: "completed"`,
    // but the parse here was silently dropping the field. Extract it
    // (and `verifiedCriteria`, the runtime-tracked counterpart) so the
    // closure-gate machinery + UI checklist nesting both work end-to-end.
    const rawAcceptance = (entry as Record<string, unknown>).acceptanceCriteria;
    const rawVerified = (entry as Record<string, unknown>).verifiedCriteria;
    const cleanCriteria = (raw: unknown): string[] | undefined => {
      if (!Array.isArray(raw)) {
        return undefined;
      }
      const cleaned = raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      return cleaned.length > 0 ? cleaned : undefined;
    };
    const acceptanceCriteria = cleanCriteria(rawAcceptance);
    const verifiedCriteria = cleanCriteria(rawVerified);
    if (typeof step !== "string" || typeof status !== "string") {
      continue;
    }
    plan.push({
      step,
      status,
      ...(typeof activeForm === "string" && activeForm.trim() ? { activeForm } : {}),
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      ...(verifiedCriteria ? { verifiedCriteria } : {}),
    });
  }
  if (plan.length === 0) {
    return null;
  }
  const rawSummary = details.summary;
  // PR-9 Tier 1: surface explicit `title` field if the agent supplied
  // one via exit_plan_mode. Fallback to summary handled by the caller.
  const rawTitle = details.title;
  // PR-10 archetype fields. All optional; only forwarded when valid.
  const rawAnalysis = details.analysis;
  const rawAssumptions = details.assumptions;
  const rawRisks = details.risks;
  const rawVerification = details.verification;
  const rawReferences = details.references;
  const cleanStringArray = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) {
      return undefined;
    }
    const cleaned = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  };
  const assumptions = cleanStringArray(rawAssumptions);
  const verification = cleanStringArray(rawVerification);
  const references = cleanStringArray(rawReferences);
  let risks: Array<{ risk: string; mitigation: string }> | undefined;
  if (Array.isArray(rawRisks)) {
    const cleanedRisks: Array<{ risk: string; mitigation: string }> = [];
    for (const entry of rawRisks) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const risk = typeof e.risk === "string" ? e.risk.trim() : "";
      const mitigation = typeof e.mitigation === "string" ? e.mitigation.trim() : "";
      if (risk.length > 0 && mitigation.length > 0) {
        cleanedRisks.push({ risk, mitigation });
      }
    }
    if (cleanedRisks.length > 0) {
      risks = cleanedRisks;
    }
  }
  return {
    plan,
    ...(typeof rawTitle === "string" && rawTitle.trim() ? { title: rawTitle.trim() } : {}),
    ...(typeof rawSummary === "string" && rawSummary.trim() ? { summary: rawSummary } : {}),
    ...(typeof rawAnalysis === "string" && rawAnalysis.trim()
      ? { analysis: rawAnalysis.trim() }
      : {}),
    ...(assumptions ? { assumptions } : {}),
    ...(risks ? { risks } : {}),
    ...(verification ? { verification } : {}),
    ...(references ? { references } : {}),
  };
}

function buildPatchSummaryText(summary: ApplyPatchSummary): string {
  const parts: string[] = [];
  if (summary.added.length > 0) {
    parts.push(`${summary.added.length} added`);
  }
  if (summary.modified.length > 0) {
    parts.push(`${summary.modified.length} modified`);
  }
  if (summary.deleted.length > 0) {
    parts.push(`${summary.deleted.length} deleted`);
  }
  return parts.length > 0 ? parts.join(", ") : "no file changes recorded";
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = normalizeOptionalLowercaseString(toolName);
  if (normalized !== "exec" && normalized !== "bash") {
    return meta;
  }
  if (!args || typeof args !== "object") {
    return meta;
  }
  const record = args as Record<string, unknown>;
  const flags: string[] = [];
  if (record.pty === true) {
    flags.push("pty");
  }
  if (record.elevated === true) {
    flags.push("elevated");
  }
  if (flags.length === 0) {
    return meta;
  }
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

function pushUniqueMediaUrl(urls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  urls.push(normalized);
}

function collectMessagingMediaUrlsFromRecord(record: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  pushUniqueMediaUrl(urls, seen, record.media);
  pushUniqueMediaUrl(urls, seen, record.mediaUrl);
  pushUniqueMediaUrl(urls, seen, record.path);
  pushUniqueMediaUrl(urls, seen, record.filePath);

  const mediaUrls = record.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    for (const mediaUrl of mediaUrls) {
      pushUniqueMediaUrl(urls, seen, mediaUrl);
    }
  }

  return urls;
}

function collectMessagingMediaUrlsFromToolResult(result: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const appendFromRecord = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }
    const extracted = collectMessagingMediaUrlsFromRecord(value as Record<string, unknown>);
    for (const url of extracted) {
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      urls.push(url);
    }
  };

  appendFromRecord(result);
  if (result && typeof result === "object") {
    appendFromRecord((result as Record<string, unknown>).details);
  }

  const outputText = extractToolResultText(result);
  if (outputText) {
    try {
      appendFromRecord(JSON.parse(outputText));
    } catch {
      // Ignore non-JSON tool output.
    }
  }

  return urls;
}

function queuePendingToolMedia(
  ctx: ToolHandlerContext,
  mediaReply: { mediaUrls: string[]; audioAsVoice?: boolean },
) {
  const seen = new Set(ctx.state.pendingToolMediaUrls);
  for (const mediaUrl of mediaReply.mediaUrls) {
    if (seen.has(mediaUrl)) {
      continue;
    }
    seen.add(mediaUrl);
    ctx.state.pendingToolMediaUrls.push(mediaUrl);
  }
  if (mediaReply.audioAsVoice) {
    ctx.state.pendingToolAudioAsVoice = true;
  }
}

async function collectEmittedToolOutputMediaUrls(
  toolName: string,
  outputText: string,
  result: unknown,
): Promise<string[]> {
  const { splitMediaFromOutput } = await loadMediaParse();
  const mediaUrls = splitMediaFromOutput(outputText).mediaUrls ?? [];
  if (mediaUrls.length === 0) {
    return [];
  }
  return filterToolResultMediaUrls(toolName, mediaUrls, result);
}

const COMPACT_PROVIDER_INVENTORY_TOOLS = new Set(["image_generate", "video_generate"]);

function hasProviderInventoryDetails(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const details = readToolResultDetailsRecord(result);
  return Array.isArray(details?.providers);
}

function shouldEmitCompactToolOutput(params: {
  toolName: string;
  result: unknown;
  outputText?: string;
}): boolean {
  if (!COMPACT_PROVIDER_INVENTORY_TOOLS.has(params.toolName)) {
    return false;
  }
  if (!hasProviderInventoryDetails(params.result)) {
    return false;
  }
  return Boolean(params.outputText?.trim());
}

function readExecApprovalPendingDetails(result: unknown): {
  approvalId: string;
  approvalSlug: string;
  expiresAtMs?: number;
  allowedDecisions?: readonly ExecApprovalDecision[];
  host: "gateway" | "node";
  command: string;
  cwd?: string;
  nodeId?: string;
  warningText?: string;
} | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const outer = result as Record<string, unknown>;
  const details =
    outer.details && typeof outer.details === "object" && !Array.isArray(outer.details)
      ? (outer.details as Record<string, unknown>)
      : outer;
  if (details.status !== "approval-pending") {
    return null;
  }
  const approvalId = readStringValue(details.approvalId) ?? "";
  const approvalSlug = readStringValue(details.approvalSlug) ?? "";
  const command = typeof details.command === "string" ? details.command : "";
  const host = details.host === "node" ? "node" : details.host === "gateway" ? "gateway" : null;
  if (!approvalId || !approvalSlug || !command || !host) {
    return null;
  }
  return {
    approvalId,
    approvalSlug,
    expiresAtMs: typeof details.expiresAtMs === "number" ? details.expiresAtMs : undefined,
    allowedDecisions: Array.isArray(details.allowedDecisions)
      ? details.allowedDecisions.filter(
          (decision): decision is ExecApprovalDecision =>
            decision === "allow-once" || decision === "allow-always" || decision === "deny",
        )
      : undefined,
    host,
    command,
    cwd: readStringValue(details.cwd),
    nodeId: readStringValue(details.nodeId),
    warningText: readStringValue(details.warningText),
  };
}

function readExecApprovalUnavailableDetails(result: unknown): {
  reason: "initiating-platform-disabled" | "initiating-platform-unsupported" | "no-approval-route";
  warningText?: string;
  channel?: string;
  channelLabel?: string;
  accountId?: string;
  sentApproverDms?: boolean;
} | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const outer = result as Record<string, unknown>;
  const details =
    outer.details && typeof outer.details === "object" && !Array.isArray(outer.details)
      ? (outer.details as Record<string, unknown>)
      : outer;
  if (details.status !== "approval-unavailable") {
    return null;
  }
  const reason =
    details.reason === "initiating-platform-disabled" ||
    details.reason === "initiating-platform-unsupported" ||
    details.reason === "no-approval-route"
      ? details.reason
      : null;
  if (!reason) {
    return null;
  }
  return {
    reason,
    warningText: readStringValue(details.warningText),
    channel: readStringValue(details.channel),
    channelLabel: readStringValue(details.channelLabel),
    accountId: readStringValue(details.accountId),
    sentApproverDms: details.sentApproverDms === true,
  };
}

async function emitToolResultOutput(params: {
  ctx: ToolHandlerContext;
  toolName: string;
  rawToolName: string;
  meta?: string;
  isToolError: boolean;
  result: unknown;
  sanitizedResult: unknown;
}) {
  const { ctx, toolName, rawToolName, meta, isToolError, result, sanitizedResult } = params;
  const hasStructuredMedia =
    result &&
    typeof result === "object" &&
    (result as { details?: unknown }).details &&
    typeof (result as { details?: unknown }).details === "object" &&
    !Array.isArray((result as { details?: unknown }).details) &&
    typeof ((result as { details?: { media?: unknown } }).details?.media ?? undefined) ===
      "object" &&
    !Array.isArray((result as { details?: { media?: unknown } }).details?.media);
  const approvalPending = readExecApprovalPendingDetails(result);
  let emittedToolOutputMediaUrls: string[] = [];
  if (!isToolError && approvalPending) {
    if (!ctx.params.onToolResult) {
      return;
    }
    ctx.state.deterministicApprovalPromptPending = true;
    try {
      const { buildExecApprovalPendingReplyPayload } = await loadExecApprovalReply();
      await ctx.params.onToolResult(
        buildExecApprovalPendingReplyPayload({
          approvalId: approvalPending.approvalId,
          approvalSlug: approvalPending.approvalSlug,
          allowedDecisions: approvalPending.allowedDecisions,
          command: approvalPending.command,
          cwd: approvalPending.cwd,
          host: approvalPending.host,
          nodeId: approvalPending.nodeId,
          expiresAtMs: approvalPending.expiresAtMs,
          warningText: approvalPending.warningText,
        }),
      );
      ctx.state.deterministicApprovalPromptSent = true;
    } catch {
      ctx.state.deterministicApprovalPromptSent = false;
    } finally {
      ctx.state.deterministicApprovalPromptPending = false;
    }
    return;
  }

  const approvalUnavailable = readExecApprovalUnavailableDetails(result);
  if (!isToolError && approvalUnavailable) {
    if (!ctx.params.onToolResult) {
      return;
    }
    ctx.state.deterministicApprovalPromptPending = true;
    try {
      const { buildExecApprovalUnavailableReplyPayload } = await loadExecApprovalReply();
      await ctx.params.onToolResult?.(
        buildExecApprovalUnavailableReplyPayload({
          reason: approvalUnavailable.reason,
          warningText: approvalUnavailable.warningText,
          channel: approvalUnavailable.channel,
          channelLabel: approvalUnavailable.channelLabel,
          accountId: approvalUnavailable.accountId,
          sentApproverDms: approvalUnavailable.sentApproverDms,
        }),
      );
      ctx.state.deterministicApprovalPromptSent = true;
    } catch {
      ctx.state.deterministicApprovalPromptSent = false;
    } finally {
      ctx.state.deterministicApprovalPromptPending = false;
    }
    return;
  }

  const outputText = extractToolResultText(sanitizedResult);
  const shouldEmitOutput =
    ctx.shouldEmitToolOutput() || shouldEmitCompactToolOutput({ toolName, result, outputText });
  if (shouldEmitOutput) {
    if (outputText) {
      ctx.emitToolOutput(rawToolName, meta, outputText, result);
      if (ctx.params.toolResultFormat === "plain") {
        emittedToolOutputMediaUrls = await collectEmittedToolOutputMediaUrls(
          rawToolName,
          outputText,
          result,
        );
      }
    }
    if (!hasStructuredMedia) {
      return;
    }
  }

  if (isToolError) {
    return;
  }

  const mediaReply = extractToolResultMediaArtifact(result);
  if (!mediaReply) {
    return;
  }
  const mediaUrls = filterToolResultMediaUrls(
    rawToolName,
    mediaReply.mediaUrls,
    result,
    ctx.builtinToolNames,
  );
  const pendingMediaUrls =
    mediaReply.audioAsVoice || emittedToolOutputMediaUrls.length === 0
      ? mediaUrls
      : mediaUrls.filter((url) => !emittedToolOutputMediaUrls.includes(url));
  if (pendingMediaUrls.length === 0) {
    return;
  }
  queuePendingToolMedia(ctx, {
    mediaUrls: pendingMediaUrls,
    ...(mediaReply.audioAsVoice ? { audioAsVoice: true } : {}),
  });
}

export function handleToolExecutionStart(
  ctx: ToolHandlerContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
): void | Promise<void> {
  const continueAfterBlockReplyFlush = (): void | Promise<void> => {
    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult.then(() => {
        continueToolExecutionStart();
      });
    }
    continueToolExecutionStart();
    return undefined;
  };

  const continueToolExecutionStart = () => {
    const rawToolName = evt.toolName;
    const toolName = normalizeToolName(rawToolName);
    const toolCallId = evt.toolCallId;
    const args = evt.args;
    const runId = ctx.params.runId;

    // Track start time and args for after_tool_call hook.
    const startedAt = Date.now();
    toolStartData.set(buildToolStartKey(runId, toolCallId), { startTime: startedAt, args });

    if (toolName === "read") {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const filePathValue =
        typeof record.path === "string"
          ? record.path
          : typeof record.file_path === "string"
            ? record.file_path
            : "";
      const filePath = filePathValue.trim();
      if (!filePath) {
        const argsPreview = readStringValue(args)?.slice(0, 200);
        ctx.log.warn(
          `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
        );
      }
    }

    const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
    ctx.state.toolMetaById.set(toolCallId, buildToolCallSummary(toolName, args, meta));
    ctx.log.debug(
      `embedded run tool start: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
    );

    const shouldEmitToolEvents = ctx.shouldEmitToolResult();
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        phase: "start",
        name: toolName,
        toolCallId,
        args: args as Record<string, unknown>,
      },
    });
    const itemData: AgentItemEventData = {
      itemId: buildToolItemId(toolCallId),
      phase: "start",
      kind: "tool",
      title: buildToolItemTitle(toolName, meta),
      status: "running",
      name: toolName,
      meta,
      toolCallId,
      startedAt,
    };
    emitTrackedItemEvent(ctx, itemData);
    // Best-effort typing signal; do not block tool summaries on slow emitters.
    void ctx.params.onAgentEvent?.({
      stream: "tool",
      data: { phase: "start", name: toolName, toolCallId },
    });

    if (isExecToolName(toolName)) {
      emitTrackedItemEvent(ctx, {
        itemId: buildCommandItemId(toolCallId),
        phase: "start",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: "running",
        name: toolName,
        meta,
        toolCallId,
        startedAt,
      });
    } else if (isPatchToolName(toolName)) {
      emitTrackedItemEvent(ctx, {
        itemId: buildPatchItemId(toolCallId),
        phase: "start",
        kind: "patch",
        title: buildPatchItemTitle(meta),
        status: "running",
        name: toolName,
        meta,
        toolCallId,
        startedAt,
      });
    }

    if (
      ctx.params.onToolResult &&
      shouldEmitToolEvents &&
      !ctx.state.toolSummaryById.has(toolCallId)
    ) {
      ctx.state.toolSummaryById.add(toolCallId);
      ctx.emitToolSummary(toolName, meta);
    }

    // Track messaging tool sends (pending until confirmed in tool_execution_end).
    if (isMessagingTool(toolName)) {
      const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const isMessagingSend = isMessagingToolSendAction(toolName, argsRecord);
      if (isMessagingSend) {
        const sendTarget = extractMessagingToolSend(toolName, argsRecord);
        if (sendTarget) {
          ctx.state.pendingMessagingTargets.set(toolCallId, sendTarget);
        }
        // Field names vary by tool: Discord/Slack use "content", sessions_send uses "message"
        const text = (argsRecord.content as string) ?? (argsRecord.message as string);
        if (text && typeof text === "string") {
          ctx.state.pendingMessagingTexts.set(toolCallId, text);
          ctx.log.debug(`Tracking pending messaging text: tool=${toolName} len=${text.length}`);
        }
        // Track media URLs from messaging tool args (pending until tool_execution_end).
        const mediaUrls = collectMessagingMediaUrlsFromRecord(argsRecord);
        if (mediaUrls.length > 0) {
          ctx.state.pendingMessagingMediaUrls.set(toolCallId, mediaUrls);
        }
      }
    }
  };

  // Flush pending block replies to preserve message boundaries before tool execution.
  const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
  if (isPromiseLike<void>(flushBlockReplyBufferResult)) {
    return flushBlockReplyBufferResult.then(() => continueAfterBlockReplyFlush());
  }
  return continueAfterBlockReplyFlush();
}

export function handleToolExecutionUpdate(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(evt.toolName);
  const toolCallId = evt.toolCallId;
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
      partialResult: sanitized,
    },
  });
  const itemData: AgentItemEventData = {
    itemId: buildToolItemId(toolCallId),
    phase: "update",
    kind: "tool",
    title: buildToolItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
    status: "running",
    name: toolName,
    meta: ctx.state.toolMetaById.get(toolCallId)?.meta,
    toolCallId,
  };
  emitTrackedItemEvent(ctx, itemData);
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
    },
  });
  if (isExecToolName(toolName)) {
    const output = extractToolResultText(sanitized);
    const commandData: AgentItemEventData = {
      itemId: buildCommandItemId(toolCallId),
      phase: "update",
      kind: "command",
      title: buildCommandItemTitle(toolName, ctx.state.toolMetaById.get(toolCallId)?.meta),
      status: "running",
      name: toolName,
      meta: ctx.state.toolMetaById.get(toolCallId)?.meta,
      toolCallId,
      ...(output ? { progressText: output } : {}),
    };
    emitTrackedItemEvent(ctx, commandData);
    if (output) {
      const outputData: AgentCommandOutputEventData = {
        itemId: commandData.itemId,
        phase: "delta",
        title: commandData.title,
        toolCallId,
        name: toolName,
        output,
        status: "running",
      };
      emitAgentCommandOutputEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: outputData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "command_output",
        data: outputData,
      });
    }
  }
}

export async function handleToolExecutionEnd(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
  },
) {
  const rawToolName = evt.toolName;
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = evt.toolCallId;
  const runId = ctx.params.runId;
  const isError = evt.isError;
  const result = evt.result;
  const isToolError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const toolStartKey = buildToolStartKey(runId, toolCallId);
  const startData = toolStartData.get(toolStartKey);
  toolStartData.delete(toolStartKey);
  const callSummary = ctx.state.toolMetaById.get(toolCallId);
  const completedMutatingAction = !isToolError && Boolean(callSummary?.mutatingAction);
  const meta = callSummary?.meta;
  ctx.state.toolMetas.push({ toolName, meta });
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  if (isToolError) {
    const errorMessage = extractToolErrorMessage(sanitizedResult);
    ctx.state.lastToolError = {
      toolName,
      meta,
      error: errorMessage,
      timedOut: isToolResultTimedOut(sanitizedResult) || undefined,
      mutatingAction: callSummary?.mutatingAction,
      actionFingerprint: callSummary?.actionFingerprint,
    };
  } else if (ctx.state.lastToolError) {
    // Keep unresolved mutating failures until the same action succeeds.
    if (ctx.state.lastToolError.mutatingAction) {
      if (
        isSameToolMutationAction(ctx.state.lastToolError, {
          toolName,
          meta,
          actionFingerprint: callSummary?.actionFingerprint,
        })
      ) {
        ctx.state.lastToolError = undefined;
      }
    } else {
      ctx.state.lastToolError = undefined;
    }
  }
  if (completedMutatingAction) {
    ctx.state.replayState = mergeEmbeddedRunReplayState(ctx.state.replayState, {
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  }

  // Commit messaging tool text on success, discard on error.
  const pendingText = ctx.state.pendingMessagingTexts.get(toolCallId);
  const pendingTarget = ctx.state.pendingMessagingTargets.get(toolCallId);
  if (pendingText) {
    ctx.state.pendingMessagingTexts.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTexts.push(pendingText);
      ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(pendingText));
      ctx.log.debug(`Committed messaging text: tool=${toolName} len=${pendingText.length}`);
      ctx.trimMessagingToolSent();
    }
  }
  if (pendingTarget) {
    ctx.state.pendingMessagingTargets.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTargets.push(pendingTarget);
      ctx.trimMessagingToolSent();
    }
  }
  const pendingMediaUrls = ctx.state.pendingMessagingMediaUrls.get(toolCallId) ?? [];
  ctx.state.pendingMessagingMediaUrls.delete(toolCallId);
  const startArgs =
    startData?.args && typeof startData.args === "object"
      ? (startData.args as Record<string, unknown>)
      : {};
  const isMessagingSend =
    pendingMediaUrls.length > 0 ||
    (isMessagingTool(toolName) && isMessagingToolSendAction(toolName, startArgs));
  if (!isToolError && isMessagingSend) {
    const committedMediaUrls = [
      ...pendingMediaUrls,
      ...collectMessagingMediaUrlsFromToolResult(result),
    ];
    if (committedMediaUrls.length > 0) {
      ctx.state.messagingToolSentMediaUrls.push(...committedMediaUrls);
      ctx.trimMessagingToolSent();
    }
  }

  // Track committed reminders only when cron.add completed successfully.
  if (!isToolError && toolName === "cron" && isCronAddAction(startData?.args)) {
    ctx.state.successfulCronAdds += 1;
  }

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      result: sanitizedResult,
    },
  });
  const endedAt = Date.now();
  const itemId = buildToolItemId(toolCallId);
  const itemData: AgentItemEventData = {
    itemId,
    phase: "end",
    kind: "tool",
    title: buildToolItemTitle(toolName, meta),
    status: isToolError ? "failed" : "completed",
    name: toolName,
    meta,
    toolCallId,
    startedAt: startData?.startTime,
    endedAt,
    ...(isToolError && extractToolErrorMessage(sanitizedResult)
      ? { error: extractToolErrorMessage(sanitizedResult) }
      : {}),
  };
  emitTrackedItemEvent(ctx, itemData);
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
    },
  });

  if (isExecToolName(toolName)) {
    const execDetails = readExecToolDetails(result);
    const commandItemId = buildCommandItemId(toolCallId);
    if (
      execDetails?.status === "approval-pending" ||
      execDetails?.status === "approval-unavailable"
    ) {
      const approvalStatus = execDetails.status === "approval-pending" ? "pending" : "unavailable";
      const approvalData: AgentApprovalEventData = {
        phase: "requested",
        kind: "exec",
        status: approvalStatus,
        title:
          approvalStatus === "pending"
            ? "Command approval requested"
            : "Command approval unavailable",
        itemId: commandItemId,
        toolCallId,
        ...(execDetails.status === "approval-pending"
          ? {
              approvalId: execDetails.approvalId,
              approvalSlug: execDetails.approvalSlug,
            }
          : {}),
        command: execDetails.command,
        host: execDetails.host,
        ...(execDetails.status === "approval-unavailable" ? { reason: execDetails.reason } : {}),
        message: execDetails.warningText,
      };
      emitAgentApprovalEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: approvalData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "approval",
        data: approvalData,
      });
      emitTrackedItemEvent(ctx, {
        itemId: commandItemId,
        phase: "end",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: "blocked",
        name: toolName,
        meta,
        toolCallId,
        startedAt: startData?.startTime,
        endedAt,
        ...(execDetails.status === "approval-pending"
          ? {
              approvalId: execDetails.approvalId,
              approvalSlug: execDetails.approvalSlug,
              summary: "Awaiting approval before command can run.",
            }
          : {
              summary: "Command is blocked because no interactive approval route is available.",
            }),
      });
    } else {
      const output =
        execDetails && "aggregated" in execDetails
          ? execDetails.aggregated
          : extractToolResultText(sanitizedResult);
      const commandStatus =
        execDetails?.status === "failed" || isToolError ? "failed" : "completed";
      emitTrackedItemEvent(ctx, {
        itemId: commandItemId,
        phase: "end",
        kind: "command",
        title: buildCommandItemTitle(toolName, meta),
        status: commandStatus,
        name: toolName,
        meta,
        toolCallId,
        startedAt: startData?.startTime,
        endedAt,
        ...(output ? { summary: output } : {}),
        ...(isToolError && extractToolErrorMessage(sanitizedResult)
          ? { error: extractToolErrorMessage(sanitizedResult) }
          : {}),
      });
      const outputData: AgentCommandOutputEventData = {
        itemId: commandItemId,
        phase: "end",
        title: buildCommandItemTitle(toolName, meta),
        toolCallId,
        name: toolName,
        ...(output ? { output } : {}),
        status: commandStatus,
        ...(execDetails && "exitCode" in execDetails ? { exitCode: execDetails.exitCode } : {}),
        ...(execDetails && "durationMs" in execDetails
          ? { durationMs: execDetails.durationMs }
          : {}),
        ...(execDetails && "cwd" in execDetails && typeof execDetails.cwd === "string"
          ? { cwd: execDetails.cwd }
          : {}),
      };
      emitAgentCommandOutputEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: outputData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "command_output",
        data: outputData,
      });

      if (typeof output === "string") {
        const parsedApprovalResult = parseExecApprovalResultText(output);
        if (parsedApprovalResult.kind === "denied") {
          const approvalData: AgentApprovalEventData = {
            phase: "resolved",
            kind: "exec",
            status: normalizeOptionalLowercaseString(parsedApprovalResult.metadata)?.includes(
              "approval-request-failed",
            )
              ? "failed"
              : "denied",
            title: "Command approval resolved",
            itemId: commandItemId,
            toolCallId,
            message: parsedApprovalResult.body || parsedApprovalResult.raw,
          };
          emitAgentApprovalEvent({
            runId: ctx.params.runId,
            ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
            data: approvalData,
          });
          void ctx.params.onAgentEvent?.({
            stream: "approval",
            data: approvalData,
          });
        }
      }
    }
  }

  if (isPatchToolName(toolName)) {
    const patchSummary = readApplyPatchSummary(result);
    const patchItemId = buildPatchItemId(toolCallId);
    const summaryText = patchSummary ? buildPatchSummaryText(patchSummary) : undefined;
    emitTrackedItemEvent(ctx, {
      itemId: patchItemId,
      phase: "end",
      kind: "patch",
      title: buildPatchItemTitle(meta),
      status: isToolError ? "failed" : "completed",
      name: toolName,
      meta,
      toolCallId,
      startedAt: startData?.startTime,
      endedAt,
      ...(summaryText ? { summary: summaryText } : {}),
      ...(isToolError && extractToolErrorMessage(sanitizedResult)
        ? { error: extractToolErrorMessage(sanitizedResult) }
        : {}),
    });
    if (patchSummary) {
      const patchData: AgentPatchSummaryEventData = {
        itemId: patchItemId,
        phase: "end",
        title: buildPatchItemTitle(meta),
        toolCallId,
        name: toolName,
        added: patchSummary.added,
        modified: patchSummary.modified,
        deleted: patchSummary.deleted,
        summary: summaryText ?? buildPatchSummaryText(patchSummary),
      };
      emitAgentPatchSummaryEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: patchData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "patch",
        data: patchData,
      });
    }
  }

  // PR-8 follow-up: plan-mode tool dispatch.
  //
  // `exit_plan_mode` proposes a plan for user approval. The runtime
  // emits a plugin-kind approval event with the plan payload + a fresh
  // approvalId; UI surfaces (Control UI overlay, channel renderers) read
  // this to render Approve/Reject/Edit buttons. The user-facing approval
  // response flows back through `sessions.patch { planApproval }` which
  // calls `resolvePlanApproval` to transition `SessionEntry.planMode`.
  //
  // `enter_plan_mode` is a transition signal — actual mode-state writes
  // happen via the user-driven `sessions.patch { planMode: "plan" }`
  // pathway. We don't auto-enter plan mode from a tool call alone (that
  // would let the agent escape the user's opt-in gate).
  // PR-8 follow-up: agent-driven plan-mode entry. Without persisting
  // the session.planMode change here, enter_plan_mode is a no-op and
  // the agent gets stuck thinking plan mode is on when it isn't.
  // Symptom: agent says "opening a fresh plan cycle" then stops, no
  // exit_plan_mode call follows because the agent's prompt logic
  // believes the user must propose work first in plan mode.
  if (toolName === "enter_plan_mode" && !isToolError && ctx.params.sessionKey) {
    const enterResult = await persistPlanModeEnter(ctx.params.sessionKey, ctx.log);
    if (enterResult.ok) {
      // PR-8 follow-up: mirror the transition into AgentRunContext so
      // sessions_spawn (and other runtime checks) can read `inPlanMode`
      // without a session-store round-trip. Drives the cleanup:"keep"
      // override for research children and the open-subagent tracking.
      const runCtx = getAgentRunContext(ctx.params.runId);
      if (runCtx) {
        runCtx.inPlanMode = true;
      }
      // PR-9 Wave B3: schedule plan-nudge wake-up crons so the agent
      // gets pulled back to the active plan even if it goes idle in
      // chat. Stored job ids are persisted so cleanup at exit/complete
      // is precise. Failures are tolerated (best-effort augmentation).
      //
      // Adversarial review #1: only schedule on FRESH entry. Repeated
      // enter_plan_mode calls when already in plan mode just refresh
      // updatedAt — scheduling more nudges in that case would append
      // entries to `nudgeJobIds` indefinitely.
      if (enterResult.freshEntry) {
        void schedulePlanNudgesAndPersist({
          sessionKey: ctx.params.sessionKey,
          log: ctx.log,
        });
      }
      const planEnterEvent: AgentApprovalEventData = {
        phase: "requested",
        kind: "plugin",
        status: "pending",
        title: "Plan mode entered",
        itemId,
        toolCallId,
        plan: [],
      };
      // Emit a lightweight event so any UI surface that tracks
      // mode-state transitions sees the change immediately. We
      // intentionally use the approval channel so it shares the same
      // delivery path; UI treats empty plan + status pending as the
      // "mode-entered" signal.
      void ctx.params.onAgentEvent?.({
        stream: "approval",
        data: planEnterEvent,
      });
    }
  }

  if (toolName === "exit_plan_mode" && !isToolError) {
    const details = readPlanProposalDetails(result);
    if (details && details.plan.length > 0) {
      const approvalId = newPlanApprovalId();
      // Persist the approvalId to SessionEntry.planMode BEFORE emitting
      // the event so the eventual sessions.patch { planApproval } can
      // match it via resolvePlanApproval's stale-id guard. Without this
      // the user clicks Approve and gets "stale approvalId" because the
      // on-disk approvalId is still undefined.
      if (ctx.params.sessionKey) {
        await persistPlanApprovalRequest(ctx.params.sessionKey, approvalId, ctx.log);
      }
      // PR-9 Tier 1: prefer explicit `title` for the approval-card
      // header. Falls back to `summary` (with "Plan approval —" prefix)
      // for backwards-compat with agents that only supplied `summary`.
      const approvalTitle = details.title
        ? details.title
        : details.summary
          ? `Plan approval — ${details.summary}`
          : "Plan approval requested";
      const approvalData: AgentApprovalEventData = {
        phase: "requested",
        kind: "plugin",
        status: "pending",
        title: approvalTitle,
        itemId,
        toolCallId,
        approvalId,
        plan: details.plan,
        ...(details.summary ? { summary: details.summary } : {}),
        // PR-10 archetype fields. Forwarded to UI/channel renderers
        // so the approval card can show analysis/assumptions/risks/etc.
        ...(details.analysis ? { analysis: details.analysis } : {}),
        ...(details.assumptions ? { assumptions: details.assumptions } : {}),
        ...(details.risks ? { risks: details.risks } : {}),
        ...(details.verification ? { verification: details.verification } : {}),
        ...(details.references ? { references: details.references } : {}),
      };
      emitAgentApprovalEvent({
        runId: ctx.params.runId,
        ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
        data: approvalData,
      });
      void ctx.params.onAgentEvent?.({
        stream: "approval",
        data: approvalData,
      });
      // PR-14: Telegram plan-mode visibility — generate the full
      // archetype as a markdown file, persist to disk, send to the
      // originating Telegram chat as a document attachment.
      // Resolution still goes through PR-11's universal /plan slash
      // commands; this bridge is read-only (visibility), no
      // approval-id translator required.
      //
      // void-fired so it never blocks the approval emit or the
      // autoApproveIfEnabled path that follows. Failures log at warn
      // and never propagate.
      if (ctx.params.sessionKey && ctx.params.agentId) {
        void (async () => {
          try {
            const { dispatchPlanArchetypeAttachment } =
              await import("./plan-mode/plan-archetype-bridge.js");
            await dispatchPlanArchetypeAttachment({
              sessionKey: ctx.params.sessionKey!,
              agentId: ctx.params.agentId!,
              details,
              log: ctx.log,
            });
          } catch (err) {
            ctx.log?.warn?.(`plan-bridge import/dispatch failed: ${String(err)}`);
          }
        })();
      }
      // PR-10 auto-mode: if the session has autoApprove=true, fire
      // `sessions.patch { planApproval: { action: "approve" } }`
      // immediately so the agent doesn't wait. The user-visible
      // sequence is: plan submitted → instantly auto-approved →
      // execution starts. If the user wants to interrupt, they can
      // toggle auto-mode off (resets the flag) or `/stop` mid-run.
      if (ctx.params.sessionKey) {
        void autoApproveIfEnabled({
          sessionKey: ctx.params.sessionKey,
          approvalId,
          log: ctx.log,
        });
      }
    }
  }

  // PR-10: ask_user_question intercept — emit a "question" approval
  // event through the same kind:"plugin" pipeline as exit_plan_mode.
  // The plan-approval card UI detects the `question` field and renders
  // one button per option instead of the standard Approve/Revise/Reject
  // triad. The user's chosen answer routes back via sessions.patch
  // { planApproval: { action: "answer", answer: <choice> } }.
  if (toolName === "ask_user_question" && !isToolError) {
    const details = readToolResultDetailsRecord(result);
    if (details && details.status === "question_submitted") {
      const questionText = typeof details.question === "string" ? details.question : "";
      const optionsRaw = details.options;
      const allowFreetext =
        typeof details.allowFreetext === "boolean" ? details.allowFreetext : false;
      const questionId = typeof details.questionId === "string" ? details.questionId : undefined;
      const options = Array.isArray(optionsRaw)
        ? optionsRaw.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
        : [];
      if (questionText && options.length >= 2) {
        // PR-10 deep-dive review: derive approvalId deterministically
        // from the tool call so transcript replay / repair produces the
        // same byte sequence (prompt-cache stability rule, same intent
        // as the H5 questionId fix on the tool side). Was previously
        // `question-<timestamp>-<random>` which invalidated the cache
        // every replay and surfaced as duplicate "stale" cards.
        const approvalId = `question-${toolCallId}`;
        const questionApprovalData: AgentApprovalEventData = {
          phase: "requested",
          kind: "plugin",
          status: "pending",
          title: "Agent has a question",
          itemId,
          toolCallId,
          approvalId,
          // Empty plan keeps the plan branch quiet on the UI side; the
          // question branch takes over.
          plan: [],
          question: {
            prompt: questionText,
            options,
            allowFreetext,
            ...(questionId ? { questionId } : {}),
          },
        };
        emitAgentApprovalEvent({
          runId: ctx.params.runId,
          ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
          data: questionApprovalData,
        });
        void ctx.params.onAgentEvent?.({
          stream: "approval",
          data: questionApprovalData,
        });
      }
    }
  }

  ctx.log.debug(
    `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  await emitToolResultOutput({
    ctx,
    toolName,
    rawToolName,
    meta,
    isToolError,
    result,
    sanitizedResult,
  });

  // Run after_tool_call plugin hook (fire-and-forget)
  const hookRunnerAfter = ctx.hookRunner ?? (await loadHookRunnerGlobal()).getGlobalHookRunner();
  if (hookRunnerAfter?.hasHooks("after_tool_call")) {
    const { consumeAdjustedParamsForToolCall } = await loadBeforeToolCall();
    const adjustedArgs = consumeAdjustedParamsForToolCall(toolCallId, runId);
    const afterToolCallArgs =
      adjustedArgs && typeof adjustedArgs === "object"
        ? (adjustedArgs as Record<string, unknown>)
        : startArgs;
    const durationMs = startData?.startTime != null ? Date.now() - startData.startTime : undefined;
    const hookEvent: PluginHookAfterToolCallEvent = {
      toolName,
      params: afterToolCallArgs,
      runId,
      toolCallId,
      result: sanitizedResult,
      error: isToolError ? extractToolErrorMessage(sanitizedResult) : undefined,
      durationMs,
    };
    void hookRunnerAfter
      .runAfterToolCall(hookEvent, {
        toolName,
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
        sessionId: ctx.params.sessionId,
        runId,
        toolCallId,
      })
      .catch((err) => {
        ctx.log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
      });
  }
}
