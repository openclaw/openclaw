import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/config.js";
import {
  resolveInboundReceiptLedgerPath,
  resolveInboundReceiptRuntimeStatePath,
  type InboundReceiptRecord,
  type InboundReceiptRuntimeState,
  type InboundReceiptStatus,
} from "../src/infra/inbound-receipt-ledger.js";
import {
  resolveChiefRuntimeStatePath,
  resolveChiefTaskLedgerPath,
  CHIEF_TASK_LEDGER_VERSION,
  CHIEF_TASK_STALE_AFTER_MS,
  type ChiefTaskContainer,
  type ChiefTaskLedgerArchive,
  type ChiefTaskPhase,
  type ChiefTaskRecord,
  type ChiefTaskSource,
  type ChiefTaskStatus,
  type ChiefRuntimeState,
} from "../src/infra/chief-task-ledger.js";

type CliArgs = {
  configPath?: string;
  agentId: string;
  json: boolean;
};

type ReceiptLedgerShape = {
  version?: number;
  receipts?: Record<string, InboundReceiptRecord>;
};

type TaskLedgerShape = {
  version?: number;
  activeBySessionKey?: Record<string, string>;
  tasks?: Record<string, ChiefTaskRecord>;
};

type PaperclipIssue = {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  updatedAt?: string;
  completedAt?: string | null;
};

type RepairSummary = {
  repairedTaskIds: string[];
  repairedReceiptIds: string[];
  paperclipIssuesConsulted: string[];
  completedReceiptIds: string[];
  ignoredReceiptIds: string[];
};

const CONTINUE_RECEIPT_PREFIX = "Continue the unfinished inbound work for receipt ";
const CONTINUE_TASK_PREFIX =
  "Resume the unfinished task below and continue it until it is finished, blocked, or clearly awaiting user input.";
const DUPLICATE_PAPERCLIP_REASON = "reconciled_duplicate_paperclip_issue_receipt";

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    agentId: "chief",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      result.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--agent") {
      result.agentId = (argv[i + 1] ?? "").trim() || "chief";
      i += 1;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
    }
  }
  return result;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isTerminalReceiptStatus(status: InboundReceiptStatus): boolean {
  return status === "done" || status === "ignored" || status === "blocked" || status === "awaiting_input";
}

function isReplayableStatus(status: InboundReceiptStatus): boolean {
  return (
    status === "received" ||
    status === "acked" ||
    status === "task_created" ||
    status === "executing" ||
    status === "reviewing"
  );
}

function isSyntheticReplayBodyText(value: string | undefined): boolean {
  const text = value?.trim() ?? "";
  return text.startsWith(CONTINUE_RECEIPT_PREFIX) || text.startsWith(CONTINUE_TASK_PREFIX);
}

function deriveTaskPhase(status: ChiefTaskStatus): ChiefTaskPhase {
  switch (status) {
    case "awaiting_input":
      return "awaiting_input";
    case "blocked":
    case "stalled":
      return "blocked";
    case "done":
      return "done";
    case "in_progress":
    default:
      return "executing";
  }
}

function isTerminalTask(task: ChiefTaskRecord | undefined): boolean {
  if (!task) {
    return false;
  }
  return task.status === "done" || task.status === "blocked" || task.status === "awaiting_input";
}

function mapTaskToReceiptStatus(task: ChiefTaskRecord): InboundReceiptStatus {
  if (task.status === "done" || task.phase === "done") {
    return "done";
  }
  if (task.status === "awaiting_input" || task.phase === "awaiting_input") {
    return "awaiting_input";
  }
  if (task.status === "blocked" || task.phase === "blocked") {
    return "blocked";
  }
  if (task.phase === "reviewing") {
    return "reviewing";
  }
  return "executing";
}

function mapPaperclipIssueToReceiptStatus(issueStatus: string | undefined): InboundReceiptStatus | null {
  const normalized = (issueStatus ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "done") {
    return "done";
  }
  if (normalized === "blocked") {
    return "blocked";
  }
  if (normalized === "in_progress") {
    return "executing";
  }
  if (normalized === "todo" || normalized === "backlog") {
    return "task_created";
  }
  return null;
}

function mapPaperclipIssueToTaskStatus(issueStatus: string | undefined): ChiefTaskStatus | null {
  const normalized = (issueStatus ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "done") {
    return "done";
  }
  if (normalized === "blocked") {
    return "blocked";
  }
  if (normalized === "in_progress") {
    return "in_progress";
  }
  return null;
}

function normalizePreview(value: string | undefined, maxChars = 280): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function deriveCanonicalTelegramMessageId(taskId: string): string | undefined {
  const trimmed = taskId.trim();
  if (!trimmed.startsWith("telegram:")) {
    return undefined;
  }
  const index = trimmed.lastIndexOf(":");
  if (index < 0 || index >= trimmed.length - 1) {
    return undefined;
  }
  return trimmed.slice(index + 1).trim() || undefined;
}

function isDuplicatePaperclipIssueReceiptId(receiptId: string | undefined, issueId: string | undefined): boolean {
  const normalizedReceiptId = receiptId?.trim() ?? "";
  const normalizedIssueId = issueId?.trim() ?? "";
  if (!normalizedReceiptId || !normalizedIssueId) {
    return false;
  }
  if (normalizedReceiptId === `paperclip|${normalizedIssueId}|${normalizedIssueId}`) {
    return true;
  }
  return normalizedReceiptId === `paperclip|${normalizedIssueId}|agent:chief:paperclip:issue:${normalizedIssueId}`;
}

function parsePaperclipTrackedIssueDescription(description: string | undefined): {
  intentSummary?: string;
  originalRequest?: string;
} {
  const text = description?.replace(/\r\n?/g, "\n") ?? "";
  if (!text.trim()) {
    return {};
  }
  const intentMatch = text.match(/^Intent summary:\s*(.+)$/m);
  const originalRequestIndex = text.indexOf("Original request:\n");
  return {
    intentSummary: intentMatch?.[1]?.trim() || undefined,
    originalRequest:
      originalRequestIndex >= 0
        ? text.slice(originalRequestIndex + "Original request:\n".length).trim() || undefined
        : undefined,
  };
}

function parseTimestampMs(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function loadPaperclipApiKeyFromDisk(): Promise<string> {
  const claimedKeyPath = path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    "paperclip-claimed-api-key.json",
  );
  return fs.readFile(claimedKeyPath, "utf8").then((raw) => {
    const parsed = JSON.parse(raw) as { apiKey?: string; token?: string };
    const token = parsed.apiKey?.trim() || parsed.token?.trim();
    if (!token) {
      throw new Error("Paperclip API key is missing from the local claimed-key file.");
    }
    return token;
  });
}

async function fetchPaperclipIssue(
  issueId: string,
  token: string,
): Promise<PaperclipIssue | null> {
  try {
    const response = await fetch(`http://127.0.0.1:3100/api/issues/${issueId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as PaperclipIssue;
  } catch {
    return null;
  }
}

function shouldTrackChiefRuntimeTask(task: ChiefTaskRecord): boolean {
  if (task.container === "ephemeral_internal") {
    return false;
  }
  if (task.source === "internal" && !task.receiptId?.trim() && !task.paperclipIssueId?.trim()) {
    return false;
  }
  return true;
}

function summarizeChiefRuntimeState(ledger: TaskLedgerShape, nowMs: number): ChiefRuntimeState {
  const tasks = Object.values(ledger.tasks ?? {})
    .filter(
      (task) =>
        (task.status === "in_progress" || task.status === "stalled") &&
        shouldTrackChiefRuntimeTask(task),
    )
    .sort((a, b) => a.lastProgressAt - b.lastProgressAt);
  const activeTasks = tasks.map((task) => ({
    taskId: task.taskId,
    sessionKey: task.sessionKey,
    sessionId: task.sessionId,
    status: task.status,
    phase: task.phase,
    container: task.container,
    source: task.source,
    title: task.title,
    promptPreview: task.promptPreview,
    activeAgents: task.activeAgents,
    currentOwner: task.currentOwner,
    receiptId: task.receiptId,
    paperclipIssueId: task.paperclipIssueId,
    lastProgressAt: task.lastProgressAt,
    staleForMs: Math.max(0, nowMs - task.lastProgressAt),
    recoveryCount: task.recoveryCount,
    fallbackStage: task.fallbackStage,
    lastRecoveryAction: task.lastRecoveryAction,
    lastFallbackAction: task.lastFallbackAction,
    lastCompactionCause: task.lastCompactionCause,
    lastError: task.lastError,
    nextStep: task.nextStep,
  }));
  return {
    version: CHIEF_TASK_LEDGER_VERSION,
    generatedAt: nowMs,
    activeTaskCount: activeTasks.length,
    stalledTaskCount: activeTasks.filter((task) => task.staleForMs >= CHIEF_TASK_STALE_AFTER_MS).length,
    activeTask: activeTasks[0],
    activeTasks,
  };
}

function summarizeReceiptRuntimeState(
  receipts: Record<string, InboundReceiptRecord>,
  nowMs: number,
): InboundReceiptRuntimeState {
  const countsByStatus: Record<InboundReceiptStatus, number> = {
    received: 0,
    acked: 0,
    task_created: 0,
    executing: 0,
    reviewing: 0,
    awaiting_input: 0,
    blocked: 0,
    done: 0,
    ignored: 0,
  };
  const allReceipts = Object.values(receipts);
  const unfinished = allReceipts.filter((receipt) => receipt.status !== "done" && receipt.status !== "ignored");
  const actionable = unfinished.filter((receipt) => isReplayableStatus(receipt.status));
  const visibleWaiting = unfinished.filter(
    (receipt) => receipt.status === "blocked" || receipt.status === "awaiting_input",
  );
  const awaitingConfirmation = visibleWaiting.filter(
    (receipt) => receipt.status === "awaiting_input" && receipt.proposalStatus === "pending_confirmation",
  );
  const replayCandidates = actionable
    .filter((receipt) => nowMs - receipt.lastProgressAt >= 5 * 60_000)
    .sort((a, b) => a.lastProgressAt - b.lastProgressAt)
    .map((receipt) => ({
      receiptId: receipt.receiptId,
      sourceType: receipt.sourceType,
      status: receipt.status,
      agentId: receipt.agentId,
      sessionKey: receipt.sessionKey,
      taskId: receipt.taskId,
      sourceMessageId: receipt.sourceMessageId,
      paperclipIssueId: receipt.paperclipIssueId,
      staleForMs: Math.max(0, nowMs - receipt.lastProgressAt),
      recoveryCount: receipt.recoveryCount,
      lastProgressAt: receipt.lastProgressAt,
    }));

  for (const receipt of allReceipts) {
    countsByStatus[receipt.status] += 1;
  }

  const maxAge = (entries: Array<{ lastProgressAt: number }>): number | null => {
    if (entries.length === 0) {
      return null;
    }
    return Math.max(...entries.map((entry) => Math.max(0, nowMs - entry.lastProgressAt)));
  };

  return {
    version: 1,
    generatedAt: nowMs,
    totalReceiptCount: allReceipts.length,
    unfinishedReceiptCount: unfinished.length,
    oldestUnfinishedReceiptAgeMs: maxAge(unfinished),
    actionableReceiptCount: actionable.length,
    oldestActionableReceiptAgeMs: maxAge(actionable),
    visibleWaitingReceiptCount: visibleWaiting.length,
    awaitingConfirmationCount: awaitingConfirmation.length,
    replayQueueCount: replayCandidates.length,
    oldestReplayCandidateAgeMs:
      replayCandidates.length > 0 ? Math.max(...replayCandidates.map((item) => item.staleForMs)) : null,
    countsByStatus,
    replayCandidates,
  };
}

function chooseTaskByPaperclipIssueId(
  tasks: ChiefTaskRecord[],
): Map<string, ChiefTaskRecord> {
  const map = new Map<string, ChiefTaskRecord>();
  for (const task of tasks) {
    const issueId = task.paperclipIssueId?.trim();
    if (!issueId) {
      continue;
    }
    const existing = map.get(issueId);
    if (!existing) {
      map.set(issueId, task);
      continue;
    }
    const existingScore =
      (existing.source !== "paperclip" ? 10 : 0) +
      (isTerminalTask(existing) ? 5 : 0) +
      existing.lastProgressAt;
    const nextScore =
      (task.source !== "paperclip" ? 10 : 0) +
      (isTerminalTask(task) ? 5 : 0) +
      task.lastProgressAt;
    if (nextScore >= existingScore) {
      map.set(issueId, task);
    }
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath =
    args.configPath ?? process.env.OPENCLAW_CONFIG_PATH ?? "C:/Users/dxhph/.openclaw/openclaw.json";
  const cfg = loadConfig(configPath);
  const receiptLedgerPath = resolveInboundReceiptLedgerPath(cfg, args.agentId);
  const receiptRuntimePath = resolveInboundReceiptRuntimeStatePath(cfg, args.agentId);
  const chiefLedgerPath = resolveChiefTaskLedgerPath(cfg, args.agentId);
  const chiefRuntimePath = resolveChiefRuntimeStatePath(cfg, args.agentId);

  const receiptLedger = ((await readJsonFile<ReceiptLedgerShape>(receiptLedgerPath)) ?? {
    version: 1,
    receipts: {},
  }) as ReceiptLedgerShape;
  const chiefLedger = ((await readJsonFile<TaskLedgerShape>(chiefLedgerPath)) ?? {
    version: CHIEF_TASK_LEDGER_VERSION,
    activeBySessionKey: {},
    tasks: {},
  }) as TaskLedgerShape;
  const receipts = receiptLedger.receipts ?? {};
  const tasks = chiefLedger.tasks ?? {};
  const summary: RepairSummary = {
    repairedTaskIds: [],
    repairedReceiptIds: [],
    paperclipIssuesConsulted: [],
    completedReceiptIds: [],
    ignoredReceiptIds: [],
  };

  const receiptEntries = Object.values(receipts);
  const receiptByTaskId = new Map<string, InboundReceiptRecord[]>();
  const receiptBySourceMessageId = new Map<string, InboundReceiptRecord>();

  for (const receipt of receiptEntries) {
    if (receipt.taskId?.trim()) {
      const list = receiptByTaskId.get(receipt.taskId.trim()) ?? [];
      list.push(receipt);
      receiptByTaskId.set(receipt.taskId.trim(), list);
    }
    const sourceId = receipt.sourceMessageId?.trim() || receipt.messageId?.trim();
    if (sourceId) {
      const existing = receiptBySourceMessageId.get(sourceId);
      if (!existing || existing.lastProgressAt <= receipt.lastProgressAt) {
        receiptBySourceMessageId.set(sourceId, receipt);
      }
    }
  }

  for (const task of Object.values(tasks)) {
    if (task.status === "done" && task.phase !== "done") {
      task.phase = "done";
      summary.repairedTaskIds.push(task.taskId);
    } else if (task.status === "blocked" && task.phase !== "blocked") {
      task.phase = "blocked";
      summary.repairedTaskIds.push(task.taskId);
    } else if (task.status === "awaiting_input" && task.phase !== "awaiting_input") {
      task.phase = "awaiting_input";
      summary.repairedTaskIds.push(task.taskId);
    }
    const canonicalSourceMessageId = deriveCanonicalTelegramMessageId(task.taskId);
    if (!canonicalSourceMessageId || task.source !== "telegram") {
      continue;
    }
    if (task.sourceMessageId === canonicalSourceMessageId) {
      continue;
    }
    const canonicalReceipt = receiptEntries.find((receipt) => {
      const sourceId = receipt.sourceMessageId?.trim() || receipt.messageId?.trim();
      return sourceId === canonicalSourceMessageId && (receipt.taskId === task.taskId || receipt.threadKey === task.threadKey);
    });
    task.sourceMessageId = canonicalSourceMessageId;
    if (canonicalReceipt) {
      task.receiptId = canonicalReceipt.receiptId;
      task.paperclipIssueId = canonicalReceipt.paperclipIssueId?.trim() || task.paperclipIssueId;
      task.threadKey = canonicalReceipt.threadKey?.trim() || task.threadKey;
      task.openIntentKey = canonicalReceipt.openIntentKey?.trim() || task.openIntentKey;
      task.intentSummary = canonicalReceipt.bodyPreview?.trim() || task.intentSummary;
      task.currentGoal = canonicalReceipt.bodyPreview?.trim() || task.currentGoal;
      task.continuityDecision = canonicalReceipt.continuityDecision || task.continuityDecision;
      task.createdByApproval =
        canonicalReceipt.proposalStatus === "approved" ? true : task.createdByApproval;
      if (Array.isArray(task.continuityHistory)) {
        task.continuityHistory = task.continuityHistory.filter((entry) => {
          return (
            entry?.sourceMessageId === canonicalSourceMessageId ||
            entry?.receiptId === canonicalReceipt.receiptId
          );
        });
      }
    }
    summary.repairedTaskIds.push(task.taskId);
  }

  for (const [sessionKey, taskId] of Object.entries(chiefLedger.activeBySessionKey ?? {})) {
    const task = tasks[taskId];
    if (!task || isTerminalTask(task)) {
      delete chiefLedger.activeBySessionKey?.[sessionKey];
    }
  }

  const taskEntries = Object.values(tasks);
  const taskByIssueId = chooseTaskByPaperclipIssueId(taskEntries);
  const taskBySourceMessageId = new Map<string, ChiefTaskRecord>();
  for (const task of taskEntries) {
    const sourceId = task.sourceMessageId?.trim();
    if (!sourceId) {
      continue;
    }
    const existing = taskBySourceMessageId.get(sourceId);
    if (!existing || existing.lastProgressAt <= task.lastProgressAt) {
      taskBySourceMessageId.set(sourceId, task);
    }
  }

  const allIssueIds = new Set<string>();
  for (const receipt of receiptEntries) {
    if (receipt.paperclipIssueId?.trim()) {
      allIssueIds.add(receipt.paperclipIssueId.trim());
    }
    if (receipt.matchedPaperclipIssueId?.trim()) {
      allIssueIds.add(receipt.matchedPaperclipIssueId.trim());
    }
  }
  for (const task of taskEntries) {
    if (task.paperclipIssueId?.trim()) {
      allIssueIds.add(task.paperclipIssueId.trim());
    }
  }

  const paperclipIssues = new Map<string, PaperclipIssue>();
  if (allIssueIds.size > 0) {
    const token = await loadPaperclipApiKeyFromDisk();
    for (const issueId of allIssueIds) {
      const issue = await fetchPaperclipIssue(issueId, token);
      if (issue) {
        paperclipIssues.set(issueId, issue);
        summary.paperclipIssuesConsulted.push(issueId);
      }
    }
  }

  for (const task of taskEntries) {
    const issueId = task.paperclipIssueId?.trim();
    if (!issueId) {
      continue;
    }
    const issue = paperclipIssues.get(issueId);
    const taskStatus = mapPaperclipIssueToTaskStatus(issue?.status);
    if (!taskStatus) {
      continue;
    }
    let changed = false;
    const localTerminal = isTerminalTask(task);
    const remoteTerminal = taskStatus === "done" || taskStatus === "blocked";
    if (localTerminal && !remoteTerminal) {
      const driftReason =
        normalizePreview(
          `paperclip issue ${issueId} remains ${issue?.status ?? "in_progress"} while local task is ${task.status}`,
          220,
        ) ?? "paperclip_issue_status_drift";
      if (task.syncDriftReason !== driftReason) {
        task.syncDriftReason = driftReason;
        changed = true;
      }
      if (changed) {
        summary.repairedTaskIds.push(task.taskId);
      }
      continue;
    }
    if (task.syncDriftReason?.trim()) {
      task.syncDriftReason = undefined;
      changed = true;
    }
    const issueProgressAt =
      parseTimestampMs(issue?.completedAt) ??
      parseTimestampMs(issue?.updatedAt) ??
      task.lastProgressAt;
    if (task.status !== taskStatus) {
      task.status = taskStatus;
      changed = true;
    }
    const nextPhase = deriveTaskPhase(taskStatus);
    if (task.phase !== nextPhase) {
      task.phase = nextPhase;
      changed = true;
    }
    if (issueProgressAt > task.lastProgressAt) {
      task.lastProgressAt = issueProgressAt;
      changed = true;
    }
    if (issueProgressAt > task.updatedAt) {
      task.updatedAt = issueProgressAt;
      changed = true;
    }
    if ((taskStatus === "done" || taskStatus === "blocked") && task.completedAt !== issueProgressAt) {
      task.completedAt = issueProgressAt;
      changed = true;
    }
    if (changed) {
      summary.repairedTaskIds.push(task.taskId);
    }
  }

  for (const receipt of receiptEntries) {
    if (receipt.status === "awaiting_input" && receipt.proposalStatus === "pending_confirmation") {
      continue;
    }
    const sourceMessageId = receipt.sourceMessageId?.trim() || receipt.messageId?.trim();
    const approvedIssueId =
      receipt.proposalStatus === "approved"
        ? receipt.matchedPaperclipIssueId?.trim() || receipt.paperclipIssueId?.trim()
        : undefined;
    const issueId = approvedIssueId || receipt.paperclipIssueId?.trim() || receipt.matchedPaperclipIssueId?.trim();
    const issue = issueId ? paperclipIssues.get(issueId) : undefined;
    const issueParsed = parsePaperclipTrackedIssueDescription(issue?.description);
    const exactTask = sourceMessageId ? taskBySourceMessageId.get(sourceMessageId) : undefined;
    const issueTask = issueId ? taskByIssueId.get(issueId) : undefined;
    let candidateTask = exactTask ?? issueTask;
    if (approvedIssueId && issueTask) {
      candidateTask = issueTask;
    }
    let changed = false;

    if (approvedIssueId && receipt.paperclipIssueId !== approvedIssueId) {
      receipt.paperclipIssueId = approvedIssueId;
      changed = true;
    }
    if (approvedIssueId && receipt.matchedPaperclipIssueId !== approvedIssueId) {
      receipt.matchedPaperclipIssueId = approvedIssueId;
      changed = true;
    }
    if (receipt.proposalStatus === "approved" && receipt.continuityDecision !== "new_task_candidate") {
      receipt.continuityDecision = "new_task_candidate";
      changed = true;
    }
    if (
      receipt.sourceType === "telegram" &&
      isSyntheticReplayBodyText(receipt.bodyText) &&
      issueParsed.originalRequest
    ) {
      receipt.bodyText = issueParsed.originalRequest;
      changed = true;
    }
    if (
      receipt.sourceType === "telegram" &&
      (isSyntheticReplayBodyText(receipt.bodyText) || !receipt.bodyPreview?.trim()) &&
      (issueParsed.intentSummary || issue?.title)
    ) {
      receipt.bodyPreview = normalizePreview(issueParsed.intentSummary || issue?.title) ?? receipt.bodyPreview;
      changed = true;
    }
    if (
      candidateTask &&
      (!receipt.taskId || receipt.taskId !== candidateTask.taskId || (issueId && receipt.paperclipIssueId !== issueId))
    ) {
      receipt.taskId = candidateTask.taskId;
      receipt.paperclipIssueId = candidateTask.paperclipIssueId?.trim() || receipt.paperclipIssueId;
      changed = true;
    }
    if (candidateTask) {
      const nextStatus = mapTaskToReceiptStatus(candidateTask);
      if (receipt.status !== nextStatus) {
        receipt.status = nextStatus;
        changed = true;
      }
      const nextProgressAt = Math.max(receipt.lastProgressAt, candidateTask.lastProgressAt);
      if (receipt.lastProgressAt !== nextProgressAt) {
        receipt.lastProgressAt = nextProgressAt;
        changed = true;
      }
      if (isTerminalReceiptStatus(nextStatus)) {
        const completedAt = Math.max(receipt.completedAt ?? 0, candidateTask.completedAt ?? candidateTask.lastProgressAt);
        if (receipt.completedAt !== completedAt) {
          receipt.completedAt = completedAt;
          changed = true;
        }
      }
    }
    const issueStatus = mapPaperclipIssueToReceiptStatus(issue?.status);
    if (issueStatus && receipt.status !== "awaiting_input") {
      const duplicatePaperclipIssueReceipt =
        receipt.sourceType === "paperclip" && isDuplicatePaperclipIssueReceiptId(receipt.receiptId, issueId);
      if (duplicatePaperclipIssueReceipt) {
        if (receipt.status !== "ignored") {
          receipt.status = "ignored";
          receipt.ignoreReason = DUPLICATE_PAPERCLIP_REASON;
          changed = true;
        }
      } else if (!candidateTask || !isTerminalTask(candidateTask)) {
        if (receipt.status !== issueStatus) {
          receipt.status = issueStatus;
          changed = true;
        }
      }
      const issueProgressAt =
        parseTimestampMs(issue?.completedAt) ??
        parseTimestampMs(issue?.updatedAt) ??
        receipt.lastProgressAt;
      if (receipt.lastProgressAt !== issueProgressAt && issueProgressAt > receipt.lastProgressAt) {
        receipt.lastProgressAt = issueProgressAt;
        changed = true;
      }
      if (issueStatus === "done" || issueStatus === "blocked") {
        const completedAt = parseTimestampMs(issue?.completedAt) ?? parseTimestampMs(issue?.updatedAt) ?? receipt.lastProgressAt;
        if (receipt.completedAt !== completedAt) {
          receipt.completedAt = completedAt;
          changed = true;
        }
      } else if (duplicatePaperclipIssueReceipt) {
        const ignoredAt = parseTimestampMs(issue?.updatedAt) ?? receipt.lastProgressAt;
        if (receipt.completedAt !== ignoredAt) {
          receipt.completedAt = ignoredAt;
          changed = true;
        }
      }
    }
    if (changed) {
      summary.repairedReceiptIds.push(receipt.receiptId);
      if (receipt.status === "done") {
        summary.completedReceiptIds.push(receipt.receiptId);
      }
      if (receipt.status === "ignored") {
        summary.ignoredReceiptIds.push(receipt.receiptId);
      }
    }
  }

  for (const [sessionKey, taskId] of Object.entries(chiefLedger.activeBySessionKey ?? {})) {
    const task = tasks[taskId];
    if (!task || isTerminalTask(task)) {
      delete chiefLedger.activeBySessionKey?.[sessionKey];
    }
  }

  chiefLedger.tasks = tasks;
  receiptLedger.receipts = receipts;

  const nowMs = Date.now();
  const chiefRuntime = summarizeChiefRuntimeState(chiefLedger, nowMs);
  const receiptRuntime = summarizeReceiptRuntimeState(receipts, nowMs);

  await writeJsonFile(chiefLedgerPath, chiefLedger);
  await writeJsonFile(chiefRuntimePath, chiefRuntime);
  await writeJsonFile(receiptLedgerPath, receiptLedger);
  await writeJsonFile(receiptRuntimePath, receiptRuntime);

  const payload = {
    configPath,
    agentId: args.agentId,
    chiefLedgerPath,
    receiptLedgerPath,
    repairedTaskCount: new Set(summary.repairedTaskIds).size,
    repairedReceiptCount: new Set(summary.repairedReceiptIds).size,
    repairedTaskIds: [...new Set(summary.repairedTaskIds)],
    repairedReceiptIds: [...new Set(summary.repairedReceiptIds)],
    completedReceiptIds: [...new Set(summary.completedReceiptIds)],
    ignoredReceiptIds: [...new Set(summary.ignoredReceiptIds)],
    paperclipIssuesConsulted: summary.paperclipIssuesConsulted,
    chiefRuntime,
    receiptRuntime,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Config: ${payload.configPath}`);
  console.log(`Agent: ${payload.agentId}`);
  console.log(`Repaired tasks: ${payload.repairedTaskCount}`);
  console.log(`Repaired receipts: ${payload.repairedReceiptCount}`);
  console.log(`Completed receipts: ${payload.completedReceiptIds.length}`);
  console.log(`Ignored duplicate paperclip receipts: ${payload.ignoredReceiptIds.length}`);
  console.log(`Receipt runtime: unfinished=${receiptRuntime.unfinishedReceiptCount} actionable=${receiptRuntime.actionableReceiptCount} replayQueue=${receiptRuntime.replayQueueCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
