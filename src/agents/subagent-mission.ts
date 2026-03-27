import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createBrainMcpClient, type BrainMcpClient } from "../memory/brain-mcp-client.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import {
  resolveAgentConfig,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { buildSubagentSystemPrompt, type SubagentRunOutcome } from "./subagent-announce.js";
import { loadMissionsFromDisk, saveMissionsToDisk } from "./subagent-mission.store.js";
import { registerSubagentRun, setRunCompletionInterceptor } from "./subagent-registry.js";
import {
  extractTranscriptSummary,
  formatTranscriptForRetry,
} from "./subagent-transcript-summary.js";
import { markTaskByMission, parseMissionLabelForListId, startTaskByMission } from "./task-list.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";
import { PSQL_PATH } from "./tools/psql-path.js";
import { TRIUMPH_WORKSPACE_ID } from "./triumph-constants.js";

const log = createSubsystemLogger("mission");

/** Truncate session labels to fit the gateway schema constraint. */
function truncLabel(label: string): string {
  return label.length > SESSION_LABEL_MAX_LENGTH ? label.slice(0, SESSION_LABEL_MAX_LENGTH) : label;
}

// ---------------------------------------------------------------------------
// Loop defaults
// ---------------------------------------------------------------------------

/**
 * Default loop cap when maxLoops is omitted or invalid.
 * 0 = unlimited (runs until status=done or LOOP_DONE sentinel).
 * >0 = cap at N iterations.
 */
export const DEFAULT_MAX_LOOPS = 5;

/**
 * Maximum consecutive fallback-continue decisions before hard-stopping.
 * Prevents runaway loops when an agent repeatedly ignores the JSON contract.
 */
export const MAX_FALLBACK_CONTINUES = 3;

/** Max chars per subtask result in the announce message. Prevents context overflow. */
const MAX_SUBTASK_RESULT_IN_ANNOUNCE = 3000;

/** Max total chars for the announce message body. Parallel missions with many subtasks get proportional truncation. */
const MAX_TOTAL_ANNOUNCE_LENGTH = 15000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopCheckpoint = {
  loopIndex: number;
  statusBlock: { status: LoopStatus; checklist: LoopChecklistItem[]; summary: string };
  timestamp: number;
};

export type MissionSubtaskInput = {
  id: string;
  agentId: string;
  task: string;
  after?: string[];
  maxLoops?: number;
  subcommandHint?: string;
  /** Saga rollback: describes how to undo this subtask if a later step fails. */
  compensationAction?: string;
};

// ---------------------------------------------------------------------------
// Findings types (Gate 6 — Autonomous Follow-up)
// ---------------------------------------------------------------------------

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type RiskTier = "green" | "yellow" | "red";
export type FollowUpStatus =
  | "pending"
  | "auto-delegated"
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "completed";

export type Finding = {
  id: string;
  severity: FindingSeverity;
  category: string;
  title: string;
  action: string;
  agent?: string;
  reversible?: boolean;
};

export type FollowUpAction = {
  findingId: string;
  severity: FindingSeverity;
  category: string;
  title: string;
  action: string;
  targetAgent: string;
  riskTier: RiskTier;
  status: FollowUpStatus;
  followUpMissionId?: string;
};

// ---------------------------------------------------------------------------
// Structured loop status contract
// ---------------------------------------------------------------------------

export type LoopStatus = "done" | "continue" | "blocked";

export type LoopChecklistItem = {
  item: string;
  pass: boolean;
};

export type LoopStatusBlock = {
  status: LoopStatus;
  checklist: LoopChecklistItem[];
  evidence: string[];
  summary: string;
};

export type LoopDecisionReason =
  | "done-all-pass" // JSON done + all checklist pass → stop
  | "done-checklist-fail" // JSON done but checklist has failures → continue
  | "continue" // JSON continue
  | "blocked" // JSON blocked → continue (with unblock context)
  | "fallback-sentinel" // no JSON, LOOP_DONE found → stop (backward compat)
  | "fallback-continue" // no JSON, no LOOP_DONE → continue (with warning)
  | "fallback-cap" // too many consecutive fallback-continues → hard-stop
  | "max-loops-hit" // loopCount >= maxLoops → stop
  | "spawn-cap" // totalSpawns >= maxTotalSpawns → stop
  | "no-looping"; // maxLoops == null → no looping configured

export type LoopDecision = {
  shouldLoop: boolean;
  reason: LoopDecisionReason;
  statusBlock: LoopStatusBlock | null;
  checklistPassRatio: number | null;
};

export type SubtaskStatus = "pending" | "running" | "ok" | "error" | "skipped";

export type SubtaskRecord = {
  id: string;
  agentId: string;
  originalTask: string;
  effectiveTask?: string;
  after: string[];
  status: SubtaskStatus;
  runId?: string;
  childSessionKey?: string;
  result?: string;
  outcome?: SubagentRunOutcome;
  retryCount: number;
  maxRetries: number;
  loopCount: number;
  maxLoops?: number;
  loopHistory: string[];
  loopFallbackCount: number; // consecutive fallback-continue iterations (resets on structured signal)
  subcommandHint?: string;
  startedAt?: number;
  endedAt?: number;
  /** Saga rollback: how to undo this subtask if a later step fails. */
  compensationAction?: string;
  /** Ralph Loop state checkpoint for gateway-restart rehydration. */
  lastCheckpoint?: LoopCheckpoint;
};

export type MissionStatus = "running" | "completed" | "partial" | "failed";

export type MissionRecord = {
  missionId: string;
  label: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  subtasks: Map<string, SubtaskRecord>;
  executionOrder: string[];
  status: MissionStatus;
  createdAt: number;
  completedAt?: number;
  totalSpawns: number;
  maxTotalSpawns: number;
  announced: boolean;
  cleanup: "delete" | "keep";
  /** When true, the mission announce injects Phase 2 delegation protocol
   *  instructions (quality gate D1-D6 + retry logic) instead of generic
   *  "synthesize" instructions. Set by /delegate spawns. */
  qualityGateRequired?: boolean;
  /** Saga rollback: compensation instructions for completed subtasks when mission fails/partial. */
  pendingCompensations?: string[];
  /** Gate 6: classified findings from subtask results. */
  followUpActions?: FollowUpAction[];
  /** 0 = original mission, 1+ = follow-up from a previous mission's Gate 6. */
  chainDepth?: number;
  /** Links back to the originating mission when this is a follow-up. */
  parentMissionId?: string;
};

// ---------------------------------------------------------------------------
// Triumph Learning Loop
// ---------------------------------------------------------------------------

/** Lazily-created Brain MCP client for triumph reads/writes */
let _missionBrainClient: BrainMcpClient | null = null;
function getMissionBrainClient(): BrainMcpClient {
  if (!_missionBrainClient) {
    // TODO: re-enable after upstream API stabilizes — brainTiered was removed from MemoryConfig
    _missionBrainClient = createBrainMcpClient({ mcporterPath: "mcporter", timeoutMs: 5000 });
  }
  return _missionBrainClient;
}

// ---------------------------------------------------------------------------
// State stores
// ---------------------------------------------------------------------------

const missions = new Map<string, MissionRecord>();
const runIdToMission = new Map<string, { missionId: string; subtaskId: string }>();

function persistMissions() {
  try {
    saveMissionsToDisk(missions);
  } catch {
    // ignore persistence failures
  }
}

// ---------------------------------------------------------------------------
// DAG validation — Kahn's topological sort
// ---------------------------------------------------------------------------

function validateSubtaskDAG(
  subtasks: MissionSubtaskInput[],
): { ok: true; order: string[] } | { ok: false; error: string } {
  const ids = new Set(subtasks.map((s) => s.id));

  // Check duplicate IDs
  if (ids.size !== subtasks.length) {
    const seen = new Set<string>();
    for (const s of subtasks) {
      if (seen.has(s.id)) {
        return { ok: false, error: `Duplicate subtask id: "${s.id}"` };
      }
      seen.add(s.id);
    }
  }

  // Check unknown references
  for (const s of subtasks) {
    for (const dep of s.after ?? []) {
      if (!ids.has(dep)) {
        return {
          ok: false,
          error: `Subtask "${s.id}" depends on unknown id "${dep}"`,
        };
      }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const s of subtasks) {
    inDegree.set(s.id, 0);
    adjacency.set(s.id, []);
  }
  for (const s of subtasks) {
    for (const dep of s.after ?? []) {
      adjacency.get(dep)!.push(s.id);
      inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (order.length !== subtasks.length) {
    return { ok: false, error: "Cycle detected in subtask dependencies" };
  }

  return { ok: true, order };
}

// ---------------------------------------------------------------------------
// Result injection
// ---------------------------------------------------------------------------

function buildTaskWithInjectedResults(mission: MissionRecord, subtask: SubtaskRecord): string {
  const deps = subtask.after;
  if (deps.length === 0) {
    return subtask.originalTask;
  }

  const sections: string[] = [];
  for (const depId of deps) {
    const dep = mission.subtasks.get(depId);
    if (!dep || dep.status !== "ok" || !dep.result) {
      continue;
    }
    sections.push(`## Results from "${depId}" (${dep.agentId})\n${dep.result}`);
  }

  if (sections.length === 0) {
    return subtask.originalTask;
  }

  return [
    "# Context: Results from prerequisite tasks",
    "",
    ...sections,
    "",
    "---",
    "",
    "# Your Task",
    subtask.originalTask,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Subtask spawning
// ---------------------------------------------------------------------------

async function spawnSubtask(mission: MissionRecord, subtask: SubtaskRecord): Promise<void> {
  const cfg = loadConfig();
  const targetAgentConfig = resolveAgentConfig(cfg, subtask.agentId);
  // TODO: re-enable after upstream API stabilizes — taskDirective not yet on ResolvedAgentConfig
  const directive = (
    (targetAgentConfig as Record<string, unknown> | undefined)?.taskDirective as string | undefined
  )?.trim();

  const taskWithResults = buildTaskWithInjectedResults(mission, subtask);
  subtask.effectiveTask = taskWithResults;

  // Search triumph shared workspace for cross-agent knowledge (5s budget)
  // Uses smart_search (~200ms Brain-side, ~1s via mcporter) — vector + graph + rerank, no LLM rewrite.
  // Agent's own workspace is already covered by the existing Recalled Memory system.
  let memorySection = "";
  try {
    const brainClient = getMissionBrainClient();
    const queryText = subtask.originalTask.slice(0, 200);

    const triumphResults = await Promise.race([
      brainClient
        .smartSearch({ query: queryText, workspaceId: TRIUMPH_WORKSPACE_ID, limit: 3 })
        .then((r) => r.results.map((x) => `- ${x.content.slice(0, 200)}`))
        .catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    if (triumphResults && triumphResults.length > 0) {
      memorySection = `## Team Knowledge\n\nThe following lessons were learned from previous missions. Apply any relevant insights to your current task — when making decisions, reference which lesson informed your choice.\n\n${triumphResults.join("\n")}\n\n---\n\n`;
    }
    log.info(
      `[triumph-inject] agent=${subtask.agentId} results=${triumphResults?.length ?? 0} memoryLen=${memorySection.length}`,
    );
  } catch (err) {
    log.warn(`[triumph-inject] failed for agent=${subtask.agentId}: ${String(err)}`);
  }

  const effectiveTask = directive
    ? `${memorySection}${taskWithResults}\n\n---\n\n${directive}`
    : `${memorySection}${taskWithResults}`;

  const childSessionKey = `agent:${subtask.agentId}:subagent:${crypto.randomUUID()}`;
  subtask.childSessionKey = childSessionKey;

  const requesterOrigin = normalizeDeliveryContext(mission.requesterOrigin);

  const subtaskLabel = truncLabel(`${mission.label}/${subtask.id}`);
  const agentSkills = resolveAgentSkillsFilter(cfg, subtask.agentId);
  log.info(
    `[skill-inject] agent=${subtask.agentId} skills=${agentSkills?.length ?? "null"} list=${agentSkills?.join(",") ?? "none"}`,
  );
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey: mission.requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: subtaskLabel,
    task: taskWithResults,
    // TODO: re-enable skills pass-through after upstream buildSubagentSystemPrompt supports it
  });

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: effectiveTask,
        sessionKey: childSessionKey,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        ...(subtask.subcommandHint ? { subcommandHint: subtask.subcommandHint } : {}),
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch {
    subtask.status = "error";
    subtask.outcome = { status: "error", error: "spawn failed" };
    subtask.endedAt = Date.now();
    skipDependentSubtasks(mission, subtask.id);
    persistMissions();
    return;
  }

  subtask.runId = childRunId;
  subtask.status = "running";
  subtask.startedAt = Date.now();
  mission.totalSpawns++;

  // Auto-track: mark linked task list task as in_progress
  startTaskByMission(mission.missionId, subtask.id, subtask.agentId);

  // Register in the subagent registry with maxRetries=0 — mission handles retries
  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: mission.requesterSessionKey,
    requesterOrigin: mission.requesterOrigin,
    requesterDisplayKey: mission.requesterDisplayKey,
    task: taskWithResults,
    cleanup: mission.cleanup,
    label: subtaskLabel,
  });

  // Index for interceptor lookup
  runIdToMission.set(childRunId, {
    missionId: mission.missionId,
    subtaskId: subtask.id,
  });

  persistMissions();
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

function shouldRetrySubtask(mission: MissionRecord, subtask: SubtaskRecord): boolean {
  return subtask.retryCount < subtask.maxRetries && mission.totalSpawns < mission.maxTotalSpawns;
}

async function retrySubtask(mission: MissionRecord, subtask: SubtaskRecord): Promise<void> {
  subtask.retryCount++;

  // Extract transcript from failed session
  const summary = subtask.childSessionKey
    ? await extractTranscriptSummary({ sessionKey: subtask.childSessionKey })
    : { toolCalls: [], toolErrorCount: 0, lastAssistantText: undefined, totalMessages: 0 };

  // If mid-loop, reconstruct the loop-formatted task so the retry preserves loop context.
  // Otherwise use the bare originalTask.
  let effectiveOriginalTask = subtask.originalTask;
  if (subtask.loopCount > 0 && subtask.loopHistory.length > 0) {
    const lastResult = subtask.loopHistory[subtask.loopHistory.length - 1];
    effectiveOriginalTask = [
      `# Loop Iteration ${subtask.loopCount}/${subtask.maxLoops} (retrying after failure)`,
      "",
      "## Most Recent Iteration Result:",
      lastResult,
      "",
      "---",
      "",
      "# Original Task",
      subtask.originalTask,
      "",
      "---",
      "",
      "# Instructions",
      "You are retrying an iterative task after a failure. The previous result is shown above.",
      "CRITICAL: Do NOT assume the previous failure reason is correct. The previous iteration may have used wrong tool parameters or given up prematurely.",
      "ALWAYS verify by trying the action yourself — open the browser, navigate to the page, and attempt the task directly.",
      "Try a DIFFERENT approach — do not repeat steps that already failed.",
      "Focus on DOING the task (using tools, browser, etc.), not on reading files or searching memory.",
      "",
      "## Required: Loop Status JSON",
      "End EVERY response with a fenced JSON block in this exact format:",
      "```json",
      JSON.stringify(
        {
          status: "done",
          checklist: [{ item: "acceptance criterion", pass: true }],
          evidence: ["concrete output, file path, or action taken"],
          summary: "one-sentence description of what was accomplished",
        },
        null,
        2,
      ),
      "```",
      "",
      'Status values: "done" = all objectives met, "continue" = still in progress, "blocked" = cannot proceed without help.',
      "The loop stops ONLY when status=done AND every checklist item has pass=true.",
      "Do NOT set status=done if any checklist item has pass=false — only declare done when all objectives are verified.",
      "BACKWARD COMPAT: You may also write LOOP_DONE before the JSON block, but the JSON block is required and takes precedence.",
    ].join("\n");
  }

  const retryTask = formatTranscriptForRetry({
    originalTask: effectiveOriginalTask,
    summary,
    retryNumber: subtask.retryCount,
    maxRetries: subtask.maxRetries,
    failureReason: subtask.outcome?.error,
  });

  // Inject dependency results into retry task too
  const deps = subtask.after;
  let taskWithContext = retryTask;
  if (deps.length > 0) {
    const sections: string[] = [];
    for (const depId of deps) {
      const dep = mission.subtasks.get(depId);
      if (!dep || dep.status !== "ok" || !dep.result) {
        continue;
      }
      sections.push(`## Results from "${depId}" (${dep.agentId})\n${dep.result}`);
    }
    if (sections.length > 0) {
      taskWithContext = [
        "# Context: Results from prerequisite tasks",
        "",
        ...sections,
        "",
        "---",
        "",
        retryTask,
      ].join("\n");
    }
  }

  const cfg = loadConfig();
  const targetAgentConfig = resolveAgentConfig(cfg, subtask.agentId);
  // TODO: re-enable after upstream API stabilizes — taskDirective not yet on ResolvedAgentConfig
  const directive = (
    (targetAgentConfig as Record<string, unknown> | undefined)?.taskDirective as string | undefined
  )?.trim();
  const effectiveTask = directive ? `${taskWithContext}\n\n---\n\n${directive}` : taskWithContext;

  const childSessionKey = `agent:${subtask.agentId}:subagent:${crypto.randomUUID()}`;
  subtask.childSessionKey = childSessionKey;

  const requesterOrigin = normalizeDeliveryContext(mission.requesterOrigin);
  const retryLabel = truncLabel(`${mission.label}/${subtask.id} (retry ${subtask.retryCount})`);
  // TODO: re-enable skills pass-through after upstream buildSubagentSystemPrompt supports it
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey: mission.requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: retryLabel,
    task: taskWithContext,
    // TODO: re-enable skills pass-through after upstream buildSubagentSystemPrompt supports it
  });

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: effectiveTask,
        sessionKey: childSessionKey,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        ...(subtask.subcommandHint ? { subcommandHint: subtask.subcommandHint } : {}),
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch {
    subtask.status = "error";
    subtask.outcome = { status: "error", error: "retry spawn failed" };
    subtask.endedAt = Date.now();
    skipDependentSubtasks(mission, subtask.id);
    persistMissions();
    return;
  }

  // Unindex old runId
  if (subtask.runId) {
    runIdToMission.delete(subtask.runId);
  }

  subtask.runId = childRunId;
  subtask.status = "running";
  subtask.startedAt = Date.now();
  subtask.endedAt = undefined;
  subtask.outcome = undefined;
  subtask.result = undefined;
  mission.totalSpawns++;

  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: mission.requesterSessionKey,
    requesterOrigin: mission.requesterOrigin,
    requesterDisplayKey: mission.requesterDisplayKey,
    task: taskWithContext,
    cleanup: mission.cleanup,
    label: truncLabel(`${mission.label}/${subtask.id}`),
  });

  runIdToMission.set(childRunId, {
    missionId: mission.missionId,
    subtaskId: subtask.id,
  });

  persistMissions();
}

// ---------------------------------------------------------------------------
// Ralph Wiggum Loop — loop-until-done for iterative agent tasks
// ---------------------------------------------------------------------------

/**
 * Parse the structured loop status JSON block from an agent's response.
 * Looks for the LAST fenced ```json code block containing a valid status field.
 * Returns null if not found or unparseable — callers fall back to sentinel logic.
 */
export function parseLoopStatusBlock(text: string): LoopStatusBlock | null {
  const fencePattern = /```json\s*\n([\s\S]*?)\n[ \t]*```/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = fencePattern.exec(text)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(lastMatch[1]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;

    if (obj.status !== "done" && obj.status !== "continue" && obj.status !== "blocked") {
      return null;
    }

    const checklist: LoopChecklistItem[] = Array.isArray(obj.checklist)
      ? obj.checklist
          .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
          .map((c) => ({
            item: typeof c.item === "string" ? c.item : "",
            pass: Boolean(c.pass),
          }))
      : [];

    const evidence: string[] = Array.isArray(obj.evidence)
      ? obj.evidence.filter((e): e is string => typeof e === "string")
      : [];

    return {
      status: obj.status as LoopStatus,
      checklist,
      evidence,
      summary: typeof obj.summary === "string" ? obj.summary : "",
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate whether a subtask should loop to the next iteration.
 * JSON status block takes precedence; LOOP_DONE sentinel is the backward-compat fallback.
 */
export function evaluateLoopDecision(mission: MissionRecord, subtask: SubtaskRecord): LoopDecision {
  // maxLoops == null → looping not configured for this subtask
  if (subtask.maxLoops == null) {
    return { shouldLoop: false, reason: "no-looping", statusBlock: null, checklistPassRatio: null };
  }

  // Spawn budget exhausted
  if (mission.totalSpawns >= mission.maxTotalSpawns) {
    return { shouldLoop: false, reason: "spawn-cap", statusBlock: null, checklistPassRatio: null };
  }

  // Per-subtask iteration cap
  if (subtask.maxLoops > 0 && subtask.loopCount >= subtask.maxLoops) {
    return {
      shouldLoop: false,
      reason: "max-loops-hit",
      statusBlock: null,
      checklistPassRatio: null,
    };
  }

  const resultText = subtask.result ?? "";

  // Debug logging for loop decision
  log.info(
    `[ralph-loop-debug] subtask="${subtask.id}" resultLength=${resultText.length} ` +
      `hasResult=${subtask.result ? "yes" : "no"}`,
  );

  // Primary: structured JSON contract
  const statusBlock = parseLoopStatusBlock(resultText);
  if (statusBlock !== null) {
    // Persist checkpoint for gateway-restart rehydration
    subtask.lastCheckpoint = {
      loopIndex: subtask.loopCount,
      statusBlock: {
        status: statusBlock.status,
        checklist: statusBlock.checklist,
        summary: statusBlock.summary ?? "",
      },
      timestamp: Date.now(),
    };

    const total = statusBlock.checklist.length;
    const passed = statusBlock.checklist.filter((c) => c.pass).length;
    const checklistPassRatio = total === 0 ? 1 : passed / total;
    const allPass = total === 0 || passed === total;

    if (statusBlock.status === "done" && allPass) {
      return { shouldLoop: false, reason: "done-all-pass", statusBlock, checklistPassRatio };
    }
    if (statusBlock.status === "done" && !allPass) {
      // Declared done but checklist has failures — keep iterating
      return { shouldLoop: true, reason: "done-checklist-fail", statusBlock, checklistPassRatio };
    }
    if (statusBlock.status === "continue") {
      return { shouldLoop: true, reason: "continue", statusBlock, checklistPassRatio };
    }
    if (statusBlock.status === "blocked") {
      return { shouldLoop: true, reason: "blocked", statusBlock, checklistPassRatio };
    }
  }

  // Fallback: LOOP_DONE sentinel — anchor to last 200 chars to avoid false positives
  // from mid-output mentions like "I will not output LOOP_DONE yet".
  const tail = resultText.slice(-200);
  if (/LOOP_DONE[^a-zA-Z0-9]*$/i.test(tail)) {
    log.warn(
      `[ralph-loop] subtask="${subtask.id}" using LOOP_DONE sentinel fallback — add JSON status block to upgrade`,
    );
    return {
      shouldLoop: false,
      reason: "fallback-sentinel",
      statusBlock: null,
      checklistPassRatio: null,
    };
  }

  // No JSON, no LOOP_DONE → check consecutive fallback limit, then continue with warning
  const fallbackCount = subtask.loopFallbackCount ?? 0;
  if (fallbackCount >= MAX_FALLBACK_CONTINUES) {
    log.warn(
      `[ralph-loop] subtask="${subtask.id}" consecutive fallback-continue cap reached (${fallbackCount}/${MAX_FALLBACK_CONTINUES}) — hard-stopping (agent is not providing JSON contract)`,
    );
    return {
      shouldLoop: false,
      reason: "fallback-cap",
      statusBlock: null,
      checklistPassRatio: null,
    };
  }

  // BUG-045 FIX: When maxLoops is set and LOOP_DONE is absent, continue looping
  // if we haven't hit the maxLoops limit yet. This ensures the Ralph Wiggum Loop works correctly.
  if (subtask.maxLoops != null && subtask.maxLoops > 0) {
    if (subtask.loopCount < subtask.maxLoops) {
      log.info(
        `[ralph-loop] subtask="${subtask.id}" maxLoops=${subtask.maxLoops} set, LOOP_DONE absent — continuing loop (iteration ${subtask.loopCount + 1}/${subtask.maxLoops})`,
      );
      return {
        shouldLoop: true,
        reason: "continue",
        statusBlock: null,
        checklistPassRatio: null,
      };
    } else {
      log.info(
        `[ralph-loop] subtask="${subtask.id}" maxLoops=${subtask.maxLoops} reached — stopping loop`,
      );
      return {
        shouldLoop: false,
        reason: "max-loops-hit",
        statusBlock: null,
        checklistPassRatio: null,
      };
    }
  }

  log.warn(
    `[ralph-loop] subtask="${subtask.id}" no JSON status block and no LOOP_DONE sentinel — defaulting to continue (fallback ${fallbackCount + 1}/${MAX_FALLBACK_CONTINUES})`,
  );
  return {
    shouldLoop: true,
    reason: "fallback-continue",
    statusBlock: null,
    checklistPassRatio: null,
  };
}

async function loopSubtask(
  mission: MissionRecord,
  subtask: SubtaskRecord,
  prevStatusBlock: LoopStatusBlock | null,
): Promise<void> {
  // Accumulate history from current iteration before clearing
  if (subtask.result) {
    subtask.loopHistory.push(subtask.result);
  }
  subtask.loopCount++;

  // Build loop context — only inject the LAST iteration's result to prevent context bloat.
  // Earlier iterations are stored in loopHistory but the agent should use Brain MCP for full history.
  const lastResult = subtask.loopHistory[subtask.loopHistory.length - 1];
  const priorCount = subtask.loopHistory.length - 1; // iterations before the last one

  const loopLabel =
    subtask.maxLoops != null && subtask.maxLoops > 0
      ? `${subtask.loopCount}/${subtask.maxLoops}`
      : `${subtask.loopCount}`;
  const contextLines: string[] = [`# Loop Iteration ${loopLabel}`, ""];

  if (priorCount > 0) {
    contextLines.push(`*${priorCount} earlier iteration(s) completed.*`, "");
  }

  // Inject resume context if there's a gap (gateway restarted between loops)
  if (subtask.lastCheckpoint && subtask.loopCount > subtask.lastCheckpoint.loopIndex + 1) {
    contextLines.push(
      `[RESUME CONTEXT] Last checkpoint (loop ${subtask.lastCheckpoint.loopIndex}): ${subtask.lastCheckpoint.statusBlock.summary}`,
      "",
    );
  }

  if (lastResult) {
    contextLines.push("## Most Recent Iteration Result:", lastResult, "", "---", "");
  }

  contextLines.push(
    "# Original Task",
    subtask.originalTask,
    "",
    "---",
    "",
    "# Instructions",
    "You are continuing an iterative task. The previous iteration result is shown above.",
    "CRITICAL: Do NOT blindly trust the previous iteration's conclusions about what is 'blocked' or 'impossible'.",
    "Previous iterations may have used wrong tool parameters or given up too early.",
    "ALWAYS verify by trying the action yourself — open the browser, navigate to the page, and attempt the task directly.",
    "If the previous iteration did NOT complete the task, try a DIFFERENT approach — do not repeat the same steps.",
    "Focus on DOING the task (using tools, browser, etc.), not on reading files or searching memory.",
  );

  // Inject unblock guidance when the previous iteration reported blocked status
  if (prevStatusBlock?.status === "blocked") {
    contextLines.push(
      "",
      "## ⚠️ Previous Iteration Was Blocked",
      `Reason: ${prevStatusBlock.summary || "(no reason given)"}`,
      "Try a completely different approach: use different tools, different parameters, or check whether the external resource is now available.",
      "Do NOT repeat the same steps that were blocked.",
      "",
    );
  }

  const isFinalIteration =
    subtask.maxLoops != null && subtask.maxLoops > 0 && subtask.loopCount >= subtask.maxLoops;

  if (isFinalIteration) {
    contextLines.push(
      "",
      "⚠️ **THIS IS YOUR FINAL ITERATION — NO MORE LOOPS AFTER THIS.**",
      "You MUST wrap up all remaining work NOW. Produce a comprehensive summary of ALL accumulated work from every iteration.",
      "Even if the task is not fully complete, provide your best-effort final JSON with status=blocked and explicit blocking reasons.",
    );
  } else {
    contextLines.push(
      "Once you have completed the main objective, set status=done in your JSON. Do NOT loop again just to verify — report your results and stop.",
      "IMPORTANT: Do NOT set status=done if any checklist item has pass=false. Only declare status=done when ALL acceptance criteria are fully met and verified.",
      "If you need another iteration, set status=continue and the next iteration will start automatically.",
    );
  }

  contextLines.push(
    "",
    "## Required: Loop Status JSON",
    "End EVERY response with a fenced JSON block in this exact format:",
    "```json",
    JSON.stringify(
      {
        status: "done",
        checklist: [{ item: "acceptance criterion", pass: true }],
        evidence: ["concrete output, file path, or action taken"],
        summary: "one-sentence description of what was accomplished",
      },
      null,
      2,
    ),
    "```",
    "",
    'Status values: "done" = all objectives met, "continue" = still in progress, "blocked" = cannot proceed without help.',
    "The loop stops ONLY when status=done AND every checklist item has pass=true.",
    "If blocked, explain what is blocking in summary and list blocked items with pass=false in checklist.",
    "BACKWARD COMPAT: You may also write LOOP_DONE on its own line before the JSON, but the JSON block is required and takes precedence.",
  );

  const loopTask = contextLines.join("\n");

  // Re-inject dependency results (same pattern as retrySubtask)
  const deps = subtask.after;
  let taskWithContext = loopTask;
  if (deps.length > 0) {
    const sections: string[] = [];
    for (const depId of deps) {
      const dep = mission.subtasks.get(depId);
      if (!dep || dep.status !== "ok" || !dep.result) {
        continue;
      }
      sections.push(`## Results from "${depId}" (${dep.agentId})\n${dep.result}`);
    }
    if (sections.length > 0) {
      taskWithContext = [
        "# Context: Results from prerequisite tasks",
        "",
        ...sections,
        "",
        "---",
        "",
        loopTask,
      ].join("\n");
    }
  }

  // Apply taskDirective if configured
  const cfg = loadConfig();
  const targetAgentConfig = resolveAgentConfig(cfg, subtask.agentId);
  // TODO: re-enable after upstream API stabilizes — taskDirective not yet on ResolvedAgentConfig
  const directive = (
    (targetAgentConfig as Record<string, unknown> | undefined)?.taskDirective as string | undefined
  )?.trim();
  const effectiveTask = directive ? `${taskWithContext}\n\n---\n\n${directive}` : taskWithContext;

  // Spawn fresh session
  const childSessionKey = `agent:${subtask.agentId}:subagent:${crypto.randomUUID()}`;

  // Unindex old runId before reassigning
  if (subtask.runId) {
    runIdToMission.delete(subtask.runId);
  }

  subtask.childSessionKey = childSessionKey;
  subtask.outcome = undefined;
  subtask.result = undefined;
  subtask.status = "running";
  subtask.startedAt = Date.now();
  subtask.endedAt = undefined;
  mission.totalSpawns++;

  const requesterOrigin = normalizeDeliveryContext(mission.requesterOrigin);
  const spawnLabel = truncLabel(`${mission.label}/${subtask.id} (loop ${loopLabel})`);
  // TODO: re-enable skills pass-through after upstream buildSubagentSystemPrompt supports it
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey: mission.requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: spawnLabel,
    task: taskWithContext,
    // TODO: re-enable skills pass-through after upstream buildSubagentSystemPrompt supports it
  });

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: effectiveTask,
        sessionKey: childSessionKey,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        ...(subtask.subcommandHint ? { subcommandHint: subtask.subcommandHint } : {}),
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch {
    subtask.status = "error";
    subtask.outcome = { status: "error", error: "loop spawn failed" };
    subtask.endedAt = Date.now();
    skipDependentSubtasks(mission, subtask.id);
    persistMissions();
    return;
  }

  subtask.runId = childRunId;
  persistMissions();

  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: mission.requesterSessionKey,
    requesterOrigin: mission.requesterOrigin,
    requesterDisplayKey: mission.requesterDisplayKey,
    task: taskWithContext,
    cleanup: mission.cleanup,
    label: truncLabel(`${mission.label}/${subtask.id}`),
  });

  runIdToMission.set(childRunId, {
    missionId: mission.missionId,
    subtaskId: subtask.id,
  });

  persistMissions();

  log.info(
    `[loop] Loop ${loopLabel} for subtask "${subtask.id}" (agent: ${subtask.agentId}) in mission ${mission.missionId.slice(0, 8)}...`,
  );
}

// ---------------------------------------------------------------------------
// Skip dependents
// ---------------------------------------------------------------------------

function skipDependentSubtasks(mission: MissionRecord, failedId: string) {
  // Transitively mark all dependents as skipped
  const toSkip = new Set<string>();
  const queue = [failedId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [, subtask] of mission.subtasks) {
      if (
        subtask.after.includes(current) &&
        subtask.status === "pending" &&
        !toSkip.has(subtask.id)
      ) {
        toSkip.add(subtask.id);
        queue.push(subtask.id);
      }
    }
  }
  for (const id of toSkip) {
    const subtask = mission.subtasks.get(id);
    if (subtask) {
      subtask.status = "skipped";
      subtask.endedAt = Date.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Mission advancement
// ---------------------------------------------------------------------------

function advanceMission(mission: MissionRecord) {
  for (const id of mission.executionOrder) {
    const subtask = mission.subtasks.get(id);
    if (!subtask || subtask.status !== "pending") {
      continue;
    }

    const deps = subtask.after;
    const allOk = deps.every((depId) => {
      const dep = mission.subtasks.get(depId);
      return dep?.status === "ok";
    });
    const anyFailed = deps.some((depId) => {
      const dep = mission.subtasks.get(depId);
      return dep?.status === "error" || dep?.status === "skipped";
    });

    if (anyFailed) {
      subtask.status = "skipped";
      subtask.endedAt = Date.now();
      skipDependentSubtasks(mission, subtask.id);
      continue;
    }

    if (allOk) {
      void spawnSubtask(mission, subtask);
    }
  }
  persistMissions();
}

// ---------------------------------------------------------------------------
// OMS status update
// ---------------------------------------------------------------------------

/**
 * Log a completed subtask spawn to oms.agent_work_log for productivity tracking.
 * Fire-and-forget — best-effort, never blocks mission flow.
 */
/**
 * Log Luna's orchestration time for a completed mission.
 * Duration = first subtask start → last subtask end (the window Luna was actively managing).
 */
function logMissionOrchestration(mission: MissionRecord): void {
  let earliest = Infinity;
  let latest = 0;
  let subtaskCount = 0;

  for (const subtask of mission.subtasks.values()) {
    if (subtask.startedAt && subtask.endedAt) {
      earliest = Math.min(earliest, subtask.startedAt);
      latest = Math.max(latest, subtask.endedAt);
      subtaskCount++;
    }
  }

  if (subtaskCount === 0 || earliest >= latest) {
    return;
  }
  const durationMs = latest - earliest;

  const startIso = new Date(earliest).toISOString();
  const endIso = new Date(latest).toISOString();
  const desc = `Orchestrated ${subtaskCount} subtask(s): ${mission.label}`
    .slice(0, 500)
    .replace(/'/g, "''");

  const sql =
    `INSERT INTO oms.agent_work_log (agent_id, work_type, source_id, duration_ms, started_at, ended_at, status, description, mission_id) ` +
    `VALUES ('luna', 'mission_orchestration', '${mission.missionId}', ${durationMs}, ` +
    `'${startIso}', '${endIso}', '${mission.status}', '${desc}', '${mission.missionId}') ` +
    `ON CONFLICT (work_type, source_id) DO NOTHING;\n`;
  const proc = spawn(PSQL_PATH, ["-d", "brain"], { stdio: ["pipe", "ignore", "ignore"] });
  proc.stdin?.write(sql);
  proc.stdin?.end();
}

function logSubtaskWork(missionId: string, subtask: SubtaskRecord): void {
  if (!subtask.startedAt || !subtask.endedAt) {
    return;
  }
  const durationMs = subtask.endedAt - subtask.startedAt;
  if (durationMs <= 0) {
    return;
  }

  const sourceId = `${missionId}:${subtask.id}`;
  const startIso = new Date(subtask.startedAt).toISOString();
  const endIso = new Date(subtask.endedAt).toISOString();
  const desc = (subtask.originalTask ?? "").slice(0, 500).replace(/'/g, "''");
  const agentId = (subtask.agentId ?? "unknown").replace(/'/g, "''");
  const status = (subtask.status ?? "unknown").replace(/'/g, "''");

  const sql =
    `INSERT INTO oms.agent_work_log (agent_id, work_type, source_id, duration_ms, started_at, ended_at, status, description, mission_id) ` +
    `VALUES ('${agentId}', 'mission_subtask', '${sourceId}', ${durationMs}, ` +
    `'${startIso}', '${endIso}', '${status}', '${desc}', '${missionId}') ` +
    `ON CONFLICT (work_type, source_id) DO UPDATE SET ` +
    `duration_ms = EXCLUDED.duration_ms, ended_at = EXCLUDED.ended_at, status = EXCLUDED.status;\n`;
  const proc = spawn(PSQL_PATH, ["-d", "brain"], { stdio: ["pipe", "ignore", "ignore"] });
  proc.stdin?.write(sql);
  proc.stdin?.end();
}

/**
 * Update OMS backlog rows for this mission to reflect final status.
 * Fire-and-forget — OMS logging is best-effort.
 */
function updateMissionStatusInOms(missionId: string, status: string): void {
  const omsStatus = status === "completed" ? "completed" : "failed";
  const sql =
    `UPDATE oms.backlog SET status='${omsStatus}' ` +
    `WHERE description LIKE '%mission ${missionId}%' ` +
    `AND status='in_progress';\n`;
  const proc = spawn(PSQL_PATH, ["-d", "brain"], { stdio: ["pipe", "ignore", "ignore"] });
  proc.stdin?.write(sql);
  proc.stdin?.end();
}

// ---------------------------------------------------------------------------
// Mission completion check
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gate 6: Findings extraction & classification
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Scans subtask result text for fenced JSON blocks containing a `findings` array.
 * Each finding must have at minimum `id` (string) and `title` (string).
 */
export function extractFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  // Match fenced JSON blocks: ```json ... ``` or ``` ... ```
  const fencedBlocks = text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g);
  for (const match of fencedBlocks) {
    const block = match[1].trim();
    if (!block.includes('"findings"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(block);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.findings)
          ? parsed.findings
          : null;
      if (!arr) {
        continue;
      }
      for (const item of arr) {
        if (typeof item?.id === "string" && typeof item?.title === "string") {
          findings.push({
            id: item.id,
            severity: (["critical", "high", "medium", "low"] as const).includes(item.severity)
              ? item.severity
              : "medium",
            category: typeof item.category === "string" ? item.category : "unknown",
            title: item.title,
            action: typeof item.action === "string" ? item.action : "",
            agent: typeof item.agent === "string" ? item.agent : undefined,
            reversible: typeof item.reversible === "boolean" ? item.reversible : undefined,
          });
        }
      }
    } catch {
      // Not valid JSON — skip this block
    }
  }
  return findings;
}

type AutonomyPolicyConfig = {
  green?: { categories: string[]; maxSeverity?: FindingSeverity };
  yellow?: { categories: string[]; maxSeverity?: FindingSeverity };
  red?: { categories: string[] };
};

/**
 * Classifies findings against the autonomy policy tiers (GREEN / YELLOW / RED).
 * Non-reversible findings auto-promote from GREEN to YELLOW minimum.
 */
export function classifyFindings(
  findings: Finding[],
  policy: AutonomyPolicyConfig,
): FollowUpAction[] {
  const greenCategories = new Set(policy.green?.categories ?? []);
  const greenMaxSeverity = SEVERITY_ORDER[policy.green?.maxSeverity ?? "medium"];
  const redCategories = new Set(policy.red?.categories ?? []);

  return findings.map((f) => {
    let tier: RiskTier;

    if (redCategories.has(f.category)) {
      tier = "red";
    } else if (
      greenCategories.has(f.category) &&
      SEVERITY_ORDER[f.severity] <= greenMaxSeverity &&
      f.reversible !== false
    ) {
      tier = "green";
    } else {
      tier = "yellow";
    }

    // Non-reversible findings auto-promote from GREEN to YELLOW
    if (tier === "green" && f.reversible === false) {
      tier = "yellow";
    }

    return {
      findingId: f.id,
      severity: f.severity,
      category: f.category,
      title: f.title,
      action: f.action,
      targetAgent: f.agent ?? "vulcan",
      riskTier: tier,
      status: "pending" as FollowUpStatus,
    };
  });
}

function checkMissionCompletion(mission: MissionRecord) {
  const statuses = [...mission.subtasks.values()].map((s) => s.status);
  const allTerminal = statuses.every((s) => s === "ok" || s === "error" || s === "skipped");
  if (!allTerminal) {
    return;
  }

  const allOk = statuses.every((s) => s === "ok");
  const allFailed = statuses.every((s) => s === "error" || s === "skipped");

  if (allOk) {
    mission.status = "completed";
  } else if (allFailed) {
    mission.status = "failed";
  } else {
    mission.status = "partial";
  }
  mission.completedAt = Date.now();

  // Saga rollback: build compensation instructions for completed subtasks when mission fails/partial
  if (mission.status === "partial" || mission.status === "failed") {
    const compensations: string[] = [];
    for (const id of [...mission.executionOrder].toReversed()) {
      const st = mission.subtasks.get(id);
      if (st?.status === "ok" && st.compensationAction) {
        compensations.push(`- Rollback **${id}** (${st.agentId}): ${st.compensationAction}`);
      }
    }
    if (compensations.length > 0) {
      mission.pendingCompensations = compensations;
    }
  }

  persistMissions();

  // Auto-track: mark linked task list tasks based on mission outcome
  markTaskByMission(mission.missionId, mission.status);

  updateMissionStatusInOms(mission.missionId, mission.status);

  // Log Luna's orchestration time for this mission (fire-and-forget)
  logMissionOrchestration(mission);

  // Append mission summary to requester agent's tier 0 daily note
  void (async () => {
    try {
      const cfg = loadConfig();
      const parsed = parseAgentSessionKey(mission.requesterSessionKey);
      const requesterId = parsed?.agentId ?? "main";
      const workspaceDir = resolveAgentWorkspaceDir(cfg, requesterId);
      const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Singapore" }); // YYYY-MM-DD in SGT
      const memoryDir = path.join(workspaceDir, "memory");
      await mkdir(memoryDir, { recursive: true });
      const memoryPath = path.join(memoryDir, `${today}.md`);
      const time = new Date().toLocaleTimeString("en-SG", {
        timeZone: "Asia/Singapore",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const statusIcon =
        mission.status === "completed"
          ? "[OK]"
          : mission.status === "partial"
            ? "[PARTIAL]"
            : "[FAIL]";
      const subtaskLines: string[] = [];
      for (const id of mission.executionOrder) {
        const st = mission.subtasks.get(id);
        if (!st) {
          continue;
        }
        const stIcon = st.status === "ok" ? "OK" : st.status === "error" ? "FAIL" : "SKIP";
        const preview = (st.result ?? st.outcome?.error ?? "").slice(0, 150).replace(/\n/g, " ");
        subtaskLines.push(`- ${stIcon} **${id}** (${st.agentId}): ${preview || "(no output)"}`);
      }
      const memEntry = [
        `\n## ${time} — ${statusIcon} Mission: ${mission.label}`,
        "",
        `**Mission:** ${mission.missionId.slice(0, 8)}`,
        "",
        ...subtaskLines,
        "",
      ].join("\n");
      await appendFile(memoryPath, memEntry, "utf-8");
    } catch {
      // Never block mission completion on memory write
    }
  })();

  if (!mission.announced) {
    void announceMissionResult(mission);
  }
}

// ---------------------------------------------------------------------------
// Announce
// ---------------------------------------------------------------------------

async function announceMissionResult(mission: MissionRecord) {
  mission.announced = true;
  persistMissions();

  const statusLabel =
    mission.status === "completed"
      ? "completed successfully"
      : mission.status === "partial"
        ? "partially completed (some subtasks failed)"
        : "failed";

  log.info(
    `[announce] mission=${mission.missionId} status=${mission.status} qualityGateRequired=${mission.qualityGateRequired ?? false}`,
  );
  const sections: string[] = [`Mission "${mission.label}" ${statusLabel}.`, ""];

  for (const id of mission.executionOrder) {
    const subtask = mission.subtasks.get(id);
    if (!subtask) {
      continue;
    }

    const statusEmoji =
      subtask.status === "ok"
        ? "[OK]"
        : subtask.status === "error"
          ? "[FAIL]"
          : subtask.status === "skipped"
            ? "[SKIP]"
            : "[?]";

    sections.push(`## ${statusEmoji} ${id} (${subtask.agentId})`);
    if (subtask.result) {
      if (subtask.result.length > MAX_SUBTASK_RESULT_IN_ANNOUNCE) {
        sections.push(subtask.result.slice(0, MAX_SUBTASK_RESULT_IN_ANNOUNCE));
        sections.push(
          `\n[... truncated — full result: ${subtask.result.length} chars. Use sessions_history for the complete output.]`,
        );
      } else {
        sections.push(subtask.result);
      }
    } else if (subtask.status === "error") {
      sections.push(`Error: ${subtask.outcome?.error ?? "unknown"}`);
    } else if (subtask.status === "skipped") {
      sections.push("Skipped due to failed dependency.");
    }
    sections.push("");
  }

  // Saga rollback: inject compensation instructions when mission failed/partial
  if (mission.pendingCompensations?.length) {
    sections.push(
      "## COMPENSATION REQUIRED",
      "",
      "The following completed subtasks need rollback due to mission failure:",
      ...mission.pendingCompensations,
      "",
      "Execute these compensations in the order listed, then report results.",
      "",
    );
  }

  // Gate 6: extract and classify findings from subtask results
  if (mission.qualityGateRequired) {
    const cfg = loadConfig();
    const autonomyPolicy: AutonomyPolicyConfig = (cfg as Record<string, unknown>).autonomy
      ? ((((cfg as Record<string, unknown>).autonomy as Record<string, unknown>)
          .policy as AutonomyPolicyConfig) ?? {})
      : {};
    const maxChainDepth =
      (((cfg as Record<string, unknown>).autonomy as Record<string, unknown> | undefined)
        ?.maxChainDepth as number) ?? 3;
    const chainDepth = mission.chainDepth ?? 0;

    // Extract findings from all completed subtask results
    const allFindings: Finding[] = [];
    for (const subtask of mission.subtasks.values()) {
      if (subtask.status === "ok" && subtask.result) {
        allFindings.push(...extractFindings(subtask.result));
      }
    }

    // Classify findings and attach to mission
    if (allFindings.length > 0) {
      const actions = classifyFindings(allFindings, autonomyPolicy);
      mission.followUpActions = actions;
      persistMissions();
    }

    sections.push(
      "## DELEGATION PROTOCOL — PHASE 2 REQUIRED",
      "",
      "This is a /delegate mission. You MUST follow Phase 2 of your delegation protocol:",
      "",
      "**Gate 4 (Quality Gate — MANDATORY):** Output a <quality_gate> block evaluating:",
      "- D1 (Decomposition): Did the agent plan before executing?",
      "- D2 (Discipline): Was the sequence logical without drift?",
      "- D3 (Outcome): Is the result correct and 100% complete?",
      "- D4 (Contribution): Did they share knowledge back?",
      "- D5 (Completion): Is it fully done or abandoned?",
      "- D6 (Execution): Did they execute real tool calls, or just output text analysis?",
      "- Scope Compliance: Did they touch unauthorized files/tools?",
      "- VERDICT: ACCEPT or RETRY",
      "- If RETRY, include: BLAME_PHASE (planning|execution|synthesis) and BLAME_DETAIL (one sentence)",
      "",
      "**Gate 5:** If RETRY → spawn a FRESH agent. Include in the new prompt:",
      "  - Original task from Gate 2",
      "  - BLAME_PHASE and BLAME_DETAIL from Gate 4",
      "  - The prior agent's result excerpt (first 500 chars) for context",
      "  Maximum 1 outer retry. If ACCEPT → proceed to Gate 6.",
    );

    // Inject findings section if any were extracted
    if (
      mission.followUpActions &&
      mission.followUpActions.length > 0 &&
      chainDepth < maxChainDepth
    ) {
      const greenActions = mission.followUpActions.filter((a) => a.riskTier === "green");
      const yellowActions = mission.followUpActions.filter((a) => a.riskTier === "yellow");
      const redActions = mission.followUpActions.filter((a) => a.riskTier === "red");

      sections.push(
        "",
        "## FINDINGS REQUIRING ACTION",
        "",
        `Chain depth: ${chainDepth}/${maxChainDepth}`,
        "",
      );

      if (greenActions.length > 0) {
        sections.push("### GREEN — Auto-delegate NOW");
        sections.push(
          "Spawn follow-up delegations for these using `spawn_sequential_mission` (qualityGateRequired: false):",
        );
        for (const a of greenActions) {
          sections.push(
            `- **${a.findingId}** [${a.severity}] ${a.title}: ${a.action} → agent: ${a.targetAgent}`,
          );
        }
        sections.push("");
      }

      if (yellowActions.length > 0) {
        sections.push("### YELLOW — Ask user before acting");
        sections.push("Present these to the user and wait for approval:");
        for (const a of yellowActions) {
          sections.push(
            `- **${a.findingId}** [${a.severity}] ${a.title}: ${a.action} → agent: ${a.targetAgent}`,
          );
        }
        sections.push("");
      }

      if (redActions.length > 0) {
        sections.push("### RED — Report only");
        sections.push("Include in [Next] field of <final> block. Do NOT act on these:");
        for (const a of redActions) {
          sections.push(`- **${a.findingId}** [${a.severity}] ${a.title}: ${a.action}`);
        }
        sections.push("");
      }
    }

    sections.push(
      "**Gate 6 (Autonomous Follow-up):** Process any FINDINGS REQUIRING ACTION section above before synthesis.",
      "  - GREEN: Spawn follow-up missions NOW.",
      "  - YELLOW: Present to user, wait for approval.",
      "  - RED: Report only in [Next].",
      "  Do NOT emit <final> until Gate 6 completes.",
      "**Gate 7:** Synthesize results, call tasks_update, output <final> block.",
      "",
      "Do NOT skip the quality gate. Do NOT synthesize without evaluating first.",
    );
  } else {
    sections.push(
      "Synthesize these results for the user. Keep it concise.",
      "Do not mention technical details like tokens, stats, or that these were background tasks.",
      "You can respond with NO_REPLY if no announcement is needed.",
    );
  }

  let triggerMessage = sections.join("\n");
  if (triggerMessage.length > MAX_TOTAL_ANNOUNCE_LENGTH) {
    log.warn(
      `[announce] message too long (${triggerMessage.length} chars), applying proportional truncation`,
    );
    // Proportional per-subtask budget
    const subtaskCount = mission.subtasks.size || 1;
    const budget = Math.floor((MAX_TOTAL_ANNOUNCE_LENGTH * 0.6) / subtaskCount);
    const trimmed: string[] = [`Mission "${mission.label}" ${statusLabel}.`, ""];
    for (const id of mission.executionOrder) {
      const subtask = mission.subtasks.get(id);
      if (!subtask) {
        continue;
      }
      const icon =
        subtask.status === "ok" ? "[OK]" : subtask.status === "error" ? "[FAIL]" : "[SKIP]";
      trimmed.push(`## ${icon} ${id} (${subtask.agentId})`);
      const text = subtask.result ?? subtask.outcome?.error ?? "";
      trimmed.push(text.slice(0, budget) + (text.length > budget ? "\n[... truncated]" : ""));
      trimmed.push("");
    }
    // Re-append instructions (quality gate or synthesis)
    const instructionStart = sections.findIndex(
      (s) => s.includes("DELEGATION PROTOCOL") || s.includes("Synthesize these results"),
    );
    if (instructionStart >= 0) {
      trimmed.push(...sections.slice(instructionStart));
    }
    triggerMessage = trimmed.join("\n");
  }

  // Direct send
  const requesterOrigin = normalizeDeliveryContext(mission.requesterOrigin);
  try {
    await callGateway({
      method: "agent",
      params: {
        sessionKey: mission.requesterSessionKey,
        message: triggerMessage,
        deliver: true,
        channel: requesterOrigin?.channel,
        accountId: requesterOrigin?.accountId,
        to: requesterOrigin?.to,
        threadId:
          requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
            ? String(requesterOrigin.threadId)
            : undefined,
        idempotencyKey: crypto.randomUUID(),
      },
      expectFinal: true,
      timeoutMs: 60_000,
    });
  } catch {
    // Best-effort announce
  }
}

// ---------------------------------------------------------------------------
// Interceptor callback — handles subtask completion from registry
// ---------------------------------------------------------------------------

async function _handleSubtaskCompletion(
  missionId: string,
  subtaskId: string,
  entry: {
    outcome?: SubagentRunOutcome;
    startedAt?: number;
    endedAt?: number;
    childSessionKey: string;
  },
) {
  const mission = missions.get(missionId);
  if (!mission) {
    return;
  }

  const subtask = mission.subtasks.get(subtaskId);
  if (!subtask) {
    return;
  }

  subtask.endedAt = entry.endedAt ?? Date.now();
  subtask.outcome = entry.outcome;

  // Log spawn duration to work_log for productivity tracking (fire-and-forget)
  logSubtaskWork(missionId, subtask);

  if (entry.outcome?.status === "ok") {
    // Read the result
    try {
      subtask.result = await readLatestAssistantReply({
        sessionKey: entry.childSessionKey,
      });
    } catch {
      // Proceed without result text
    }

    // Append result to agent's tier 0 daily memory note (real-time, no LLM).
    // Capture values synchronously before the first await — loopSubtask() clears
    // subtask.result after pushing it to loopHistory, so reading it after an
    // await would race and produce "(no result captured)".
    {
      const capturedResult = subtask.result ?? "(no result captured)";
      const capturedAgentId = subtask.agentId;
      const capturedSubtaskId = subtask.id;
      const capturedLabel = mission.label;
      void (async () => {
        try {
          const cfg = loadConfig();
          const workspaceDir = resolveAgentWorkspaceDir(cfg, capturedAgentId);
          const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Singapore" }); // YYYY-MM-DD in SGT
          const memoryDir = path.join(workspaceDir, "memory");
          await mkdir(memoryDir, { recursive: true });
          const memoryPath = path.join(memoryDir, `${today}.md`);
          const time = new Date().toLocaleTimeString("en-SG", {
            timeZone: "Asia/Singapore",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          const memEntry = [
            `\n## ${time} — ${capturedLabel}`,
            "",
            `**Subtask:** ${capturedSubtaskId}`,
            "",
            capturedResult,
            "",
          ].join("\n");
          await appendFile(memoryPath, memEntry, "utf-8");
        } catch {
          // Never block mission completion on memory write
        }
      })();
    }

    // Write result to triumph workspace for cross-agent learning (fire-and-forget)
    {
      const triumphResult = subtask.result;
      const triumphLabel = mission.label;
      const triumphAgentId = subtask.agentId;
      void (async () => {
        try {
          const content = `[${triumphAgentId}] ${triumphLabel} — ${(triumphResult ?? "").slice(0, 400)}`;
          await getMissionBrainClient().createMemory({
            content,
            workspaceId: TRIUMPH_WORKSPACE_ID,
            metadata: {
              type: "agent_result",
              agentId: triumphAgentId,
              missionLabel: triumphLabel,
              date: new Date().toISOString().slice(0, 10),
            },
          });
        } catch {
          // Never block mission completion on triumph write
        }
      })();
    }

    // Ralph Wiggum loop check: if looping is enabled and not done, spawn next iteration
    const loopDecision = evaluateLoopDecision(mission, subtask);
    log.info(
      `[ralph-loop] subtask="${subtask.id}" loopCount=${subtask.loopCount} ` +
        `maxLoops=${subtask.maxLoops ?? "none"} ` +
        `jsonStatus=${loopDecision.statusBlock?.status ?? "no-json"} ` +
        `checklistPassRatio=${loopDecision.checklistPassRatio != null ? loopDecision.checklistPassRatio.toFixed(2) : "n/a"} ` +
        `decision=${loopDecision.reason} fallbackCount=${subtask.loopFallbackCount ?? 0}`,
    );
    // Track consecutive fallback-continues — reset whenever agent provides a structured signal
    if (loopDecision.reason === "fallback-continue") {
      subtask.loopFallbackCount = (subtask.loopFallbackCount ?? 0) + 1;
    } else {
      subtask.loopFallbackCount = 0;
    }
    if (loopDecision.shouldLoop) {
      await loopSubtask(mission, subtask, loopDecision.statusBlock);
      return; // Not terminal yet — new iteration is running
    }

    subtask.status = "ok";
    persistMissions();
    advanceMission(mission);
    checkMissionCompletion(mission);
  } else {
    // BUG-046 FIX: Always evaluate loop decision regardless of session outcome.
    // When maxLoops is set and loopCount < maxLoops, the loop should continue
    // even if the session crashed (context overflow error, etc.).
    const loopDecision = evaluateLoopDecision(mission, subtask);
    log.info(
      `[ralph-loop] subtask="${subtask.id}" loopCount=${subtask.loopCount} ` +
        `maxLoops=${subtask.maxLoops ?? "none"} ` +
        `outcome=error error="${subtask.outcome?.error ?? "unknown"}" ` +
        `decision=${loopDecision.reason} shouldLoop=${loopDecision.shouldLoop}`,
    );

    if (loopDecision.shouldLoop) {
      // Track consecutive fallback-continues — reset whenever agent provides a structured signal
      if (loopDecision.reason === "fallback-continue") {
        subtask.loopFallbackCount = (subtask.loopFallbackCount ?? 0) + 1;
      } else {
        subtask.loopFallbackCount = 0;
      }
      await loopSubtask(mission, subtask, loopDecision.statusBlock);
      return; // Not terminal yet — new iteration is running
    }

    // Loop decision says stop — fall through to normal error handling
    if (shouldRetrySubtask(mission, subtask)) {
      await retrySubtask(mission, subtask);
    } else {
      subtask.status = "error";
      skipDependentSubtasks(mission, subtask.id);
      persistMissions();
      advanceMission(mission);
      checkMissionCompletion(mission);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createMission(params: {
  label: string;
  subtasks: MissionSubtaskInput[];
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  cleanup?: "delete" | "keep";
  maxTotalSpawns?: number;
  qualityGateRequired?: boolean;
  chainDepth?: number;
  parentMissionId?: string;
}): { missionId: string } | { error: string } {
  const dagResult = validateSubtaskDAG(params.subtasks);
  if (!dagResult.ok) {
    return { error: dagResult.error };
  }

  const cfg = loadConfig();
  const missionId = crypto.randomUUID();
  const subtaskMap = new Map<string, SubtaskRecord>();

  for (const input of params.subtasks) {
    const agentConfig = resolveAgentConfig(cfg, input.agentId);
    subtaskMap.set(input.id, {
      id: input.id,
      agentId: input.agentId,
      originalTask: input.task,
      after: input.after ?? [],
      status: "pending",
      retryCount: 0,
      // TODO: re-enable after upstream API stabilizes — maxRetries not yet on ResolvedAgentConfig
      maxRetries: ((agentConfig as Record<string, unknown> | undefined)?.maxRetries as number) ?? 0,
      loopCount: 0,
      maxLoops: input.maxLoops,
      loopHistory: [],
      loopFallbackCount: 0,
      subcommandHint: input.subcommandHint,
      compensationAction: input.compensationAction,
    });
  }

  const mission: MissionRecord = {
    missionId,
    label: params.label,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(params.requesterOrigin),
    requesterDisplayKey: params.requesterDisplayKey,
    subtasks: subtaskMap,
    executionOrder: dagResult.order,
    status: "running",
    createdAt: Date.now(),
    totalSpawns: 0,
    maxTotalSpawns:
      params.maxTotalSpawns ??
      (() => {
        const hasUnlimited = params.subtasks.some((s) => s.maxLoops === 0);
        if (hasUnlimited) {
          return 999;
        } // Unlimited loops — generous budget, LOOP_DONE is the real exit
        const loopSlots = params.subtasks.reduce((sum, s) => sum + (s.maxLoops ?? 0), 0);
        return (params.subtasks.length + loopSlots) * 3;
      })(),
    announced: false,
    cleanup: params.cleanup ?? "keep",
    qualityGateRequired: params.qualityGateRequired ?? false,
    chainDepth: params.chainDepth ?? 0,
    parentMissionId: params.parentMissionId,
  };

  missions.set(missionId, mission);
  persistMissions();

  // Auto-link to task list if mission label contains listId:<uuid>: prefix
  parseMissionLabelForListId(params.label, missionId);

  // Spawn root subtasks (no dependencies)
  advanceMission(mission);

  return { missionId };
}

export function findMissionByRunId(
  runId: string,
): { missionId: string; subtaskId: string } | undefined {
  return runIdToMission.get(runId);
}

export function getMission(missionId: string): MissionRecord | undefined {
  return missions.get(missionId);
}

export function initMissionSystem() {
  // Restore persisted missions
  try {
    const restored = loadMissionsFromDisk();
    const missionsNeedingRecovery: MissionRecord[] = [];

    for (const [id, mission] of restored.entries()) {
      if (missions.has(id)) {
        continue;
      }
      missions.set(id, mission);

      if (mission.status !== "running") {
        continue;
      }

      let needsRecovery = false;

      for (const [_subtaskId, subtask] of mission.subtasks) {
        if (subtask.status !== "running") {
          continue;
        }

        // TODO: re-enable after upstream API stabilizes — getSubagentRun not exported from subagent-registry
        // Without getSubagentRun, treat all running subtasks as lost during restart.
        subtask.status = "error";
        subtask.endedAt = Date.now();
        subtask.outcome = { status: "error", error: "session lost during gateway restart" };
        skipDependentSubtasks(mission, subtask.id);
        needsRecovery = true;
      }

      // Mark any un-spawned pending subtasks as error too — they were never
      // going to run since the gateway restarted and the mission is stale.
      if (needsRecovery) {
        for (const [, sub] of mission.subtasks) {
          if (sub.status === "pending") {
            sub.status = "skipped";
            sub.endedAt = Date.now();
          }
        }
      }

      // Always check running missions — subtasks may have been recovered in
      // a previous restart but mission status never transitioned to terminal.
      missionsNeedingRecovery.push(mission);
    }

    // Finalize recovered missions
    for (const mission of missionsNeedingRecovery) {
      checkMissionCompletion(mission);
    }
  } catch {
    // ignore restore failures
  }

  // Route subagent run completions to mission subtask handlers.
  // When a run belongs to a mission, the interceptor claims it so the per-subagent
  // announce flow is skipped — the mission system handles its own announce.
  setRunCompletionInterceptor((runId, entry) => {
    const match = runIdToMission.get(runId);
    if (!match) {
      return false;
    }
    log.info(
      `[interceptor] claimed run=${runId} mission=${match.missionId} subtask=${match.subtaskId}`,
    );
    runIdToMission.delete(runId);
    void _handleSubtaskCompletion(match.missionId, match.subtaskId, {
      outcome: entry.outcome,
      startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
      endedAt: typeof entry.endedAt === "number" ? entry.endedAt : undefined,
      childSessionKey: entry.childSessionKey,
    });
    return true;
  });
}

export function resetMissionSystemForTests() {
  missions.clear();
  runIdToMission.clear();
}

/**
 * Look up a subtask by its child session key.
 * Used by the write-tool hook to detect if the current session is a mission
 * subtask, so it can auto-prepend existing file content (append mode).
 */
export function findSubtaskBySessionKey(childSessionKey: string): SubtaskRecord | undefined {
  for (const mission of missions.values()) {
    for (const subtask of mission.subtasks.values()) {
      if (subtask.childSessionKey === childSessionKey) {
        return subtask;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Testing exports
// ---------------------------------------------------------------------------
export const __testing = {
  announceMissionResult,
  missions,
  extractFindings,
  classifyFindings,
};
