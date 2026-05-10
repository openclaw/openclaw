import path from "node:path";
import type { CodexContinuityBridgeConfig } from "./config.js";
import type {
  CodexBridgeEventClass,
  CodexBridgeEventInput,
  CodexBridgeThread,
  CodexBridgeWatchRecord,
  CodexBridgeWriteDecision,
  CodexBridgeWriteRequest,
} from "./types.js";

const TERMINAL_GOAL_STATUSES = new Set(["complete", "failed", "cancelled", "canceled"]);
const RISKY_WORDS =
  /\b(deploy|publish|delete|reset|trade|secret|token|password|auth|credential|spend|payment|production)\b/i;

export function classifyCodexBridgeEvent(input: CodexBridgeEventInput): CodexBridgeEventClass {
  if (input.eventClass) {
    return input.eventClass;
  }
  const haystack = `${input.eventType ?? ""} ${input.status ?? ""} ${input.summary ?? ""}`;
  if (/\bauth|login|token|credential\b/i.test(haystack)) {
    return "auth_failure";
  }
  if (/\bapproval|permission\b/i.test(haystack)) {
    return "approval_required";
  }
  if (/\bblocked|needs user|decision required|waiting\b/i.test(haystack)) {
    return "blocker";
  }
  if (/\bfailed|failure|error|cancelled|canceled\b/i.test(haystack)) {
    return "failure";
  }
  if (
    TERMINAL_GOAL_STATUSES.has((input.status ?? "").toLowerCase()) ||
    /\bcomplete|done|finished\b/i.test(haystack)
  ) {
    return "completion";
  }
  if (/\btool|delta|token|stream|outputDelta\b/i.test(haystack)) {
    return "noisy_progress";
  }
  return "meaningful_progress";
}

export function shouldNotifyWatch(params: {
  watch: CodexBridgeWatchRecord;
  event: CodexBridgeEventInput;
  eventClass: CodexBridgeEventClass;
  nowMs?: number;
}): { notify: boolean; dedupeKey: string; reasons: string[] } {
  const nowMs = params.nowMs ?? Date.now();
  const expiresMs = Date.parse(params.watch.expiresAt);
  const reasons: string[] = [];
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
    return { notify: false, dedupeKey: "", reasons: ["watch expired"] };
  }
  if (params.watch.scope === "thread" && params.watch.threadId !== params.event.threadId) {
    return { notify: false, dedupeKey: "", reasons: ["event thread does not match watch"] };
  }
  if (params.watch.scope === "goal" && params.watch.goalKey !== params.event.goalKey) {
    return { notify: false, dedupeKey: "", reasons: ["event goal does not match watch"] };
  }
  const allowed = allowedClassesForVerbosity(params.watch.verbosity);
  if (!allowed.has(params.eventClass)) {
    return { notify: false, dedupeKey: "", reasons: [`suppressed ${params.eventClass}`] };
  }
  const dedupeKey = [
    params.watch.watchId,
    params.event.threadId ?? "thread",
    params.event.goalKey ?? "goal",
    params.eventClass,
    params.event.status ?? params.event.updatedAtMs ?? params.event.turnId ?? "event",
  ].join(":");
  if (params.watch.dedupeKeyLastSeen === dedupeKey) {
    return { notify: false, dedupeKey, reasons: ["duplicate event"] };
  }
  reasons.push(`watch allows ${params.eventClass}`);
  return { notify: true, dedupeKey, reasons };
}

export function validateCodexWriteRequest(params: {
  request: CodexBridgeWriteRequest;
  config: CodexContinuityBridgeConfig;
  threads: CodexBridgeThread[];
  dirtyRepos?: Set<string>;
}): CodexBridgeWriteDecision {
  const request = params.request;
  const reasons: string[] = [];
  if (!params.config.enableTelegramWrites) {
    return reject("write_feature_flag_off", "Telegram-to-Codex writes are disabled.", [
      "codexBridge.enableTelegramWrites is false",
    ]);
  }
  if (!request.prompt.trim()) {
    return reject("empty_prompt", "A Codex write request needs a prompt.", ["empty prompt"]);
  }
  if (!request.provenance) {
    return reject("missing_provenance", "Mutating Codex requests require provenance metadata.", [
      "missing provenance",
    ]);
  }
  if (!request.provenance.requestedBy || !request.provenance.requestId) {
    return reject(
      "incomplete_provenance",
      "Mutating Codex requests require requestedBy and requestId.",
      ["provenance must include requestedBy and requestId"],
    );
  }
  if (request.provenance.riskClass === "high") {
    return reject(
      "high_risk_refused",
      "High-risk Telegram-originated Codex writes require local approval.",
      ["riskClass=high"],
    );
  }
  if (RISKY_WORDS.test(request.prompt) && request.provenance.confirmed !== true) {
    return reject(
      "risky_request_needs_confirmation",
      "This Codex write request needs explicit confirmation.",
      ["risky wording detected"],
    );
  }
  if (
    request.requestedBySenderId &&
    params.config.trustedTelegramSenders.length > 0 &&
    !params.config.trustedTelegramSenders.includes(request.requestedBySenderId)
  ) {
    return reject("wrong_sender", "This sender is not trusted for Telegram-to-Codex writes.", [
      "sender not in trustedTelegramSenders",
    ]);
  }
  if (params.config.confirmedWriteMethods.length === 0) {
    return reject(
      "write_capability_unconfirmed",
      "Codex app-server write methods are not confirmed.",
      ["confirmedWriteMethods is empty"],
    );
  }
  if (request.action === "goal" && !params.config.confirmedWriteMethods.includes("turn/start")) {
    return reject("turn_start_unconfirmed", "Codex turn/start is not confirmed.", [
      "turn/start missing from confirmedWriteMethods",
    ]);
  }
  if (request.action === "steer" && !params.config.confirmedWriteMethods.includes("turn/steer")) {
    return reject("turn_steer_unconfirmed", "Codex turn/steer is not confirmed.", [
      "turn/steer missing from confirmedWriteMethods",
    ]);
  }
  if (request.action === "steer" && !request.turnId) {
    return reject("missing_turn_id", "Steering Codex requires the active turn id precondition.", [
      "missing turnId",
    ]);
  }
  const selected = selectCodexThread({
    threads: params.threads,
    repoPath: request.repoPath,
    threadId: request.threadId,
    prompt: request.prompt,
  });
  if (!selected.ok) {
    return {
      ok: false,
      code: selected.code,
      message: selected.message,
      reasons: selected.reasons,
      candidates: selected.candidates,
    };
  }
  const repoPath = selected.thread.cwd ?? request.repoPath;
  if (!isRepoAllowed(repoPath, params.config.allowedRepos)) {
    return reject("repo_not_allowlisted", "Target repo is not in codexBridge.allowedRepos.", [
      `repo=${repoPath ?? "<unknown>"}`,
    ]);
  }
  if (repoPath && params.dirtyRepos?.has(repoPath) && request.provenance.confirmed !== true) {
    return reject(
      "dirty_repo_needs_confirmation",
      "Dirty repo state requires explicit confirmation.",
      [`repo=${repoPath}`],
    );
  }
  reasons.push(...selected.reasons, "write request passed bridge policy");
  return {
    ok: true,
    action: request.action,
    threadId: selected.thread.id,
    repoPath,
    reasons,
  };
}

export function selectCodexThread(params: {
  threads: CodexBridgeThread[];
  threadId?: string;
  repoPath?: string;
  prompt?: string;
}):
  | { ok: true; thread: CodexBridgeThread; score: number; reasons: string[] }
  | {
      ok: false;
      code: string;
      message: string;
      reasons: string[];
      candidates?: Array<{ thread: CodexBridgeThread; score: number; reasons: string[] }>;
    } {
  if (params.threadId) {
    const exact = params.threads.find((thread) => thread.id === params.threadId);
    if (!exact) {
      return {
        ok: false,
        code: "thread_not_found",
        message: "Requested Codex thread was not found.",
        reasons: [`threadId=${params.threadId}`],
      };
    }
    return { ok: true, thread: exact, score: 100, reasons: ["explicit thread id"] };
  }
  const candidates = params.threads
    .map((thread) => scoreThreadSelection(thread, params))
    .filter((candidate) => candidate.score > 0)
    .toSorted((a, b) => b.score - a.score);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "no_target_thread",
      message: "No plausible Codex thread was found.",
      reasons: ["no matching active/recent thread"],
    };
  }
  const [best, second] = candidates;
  if (!best) {
    return {
      ok: false,
      code: "no_target_thread",
      message: "No plausible Codex thread was found.",
      reasons: ["no candidates"],
    };
  }
  if (second && best.score - second.score < 20) {
    return {
      ok: false,
      code: "ambiguous_target_thread",
      message: "Multiple plausible Codex threads matched. Pick one before sending anything.",
      reasons: ["top candidates within 20 points"],
      candidates: candidates.slice(0, 3),
    };
  }
  return { ok: true, thread: best.thread, score: best.score, reasons: best.reasons };
}

function scoreThreadSelection(
  thread: CodexBridgeThread,
  params: { repoPath?: string; prompt?: string },
): { thread: CodexBridgeThread; score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (thread.status === "active") {
    score += 30;
    reasons.push("active/running");
  }
  if (params.repoPath && samePath(thread.cwd, params.repoPath)) {
    score += 30;
    reasons.push("repo path match");
  }
  if (thread.updatedAtMs && Date.now() - thread.updatedAtMs < 30 * 60_000) {
    score += 10;
    reasons.push("updated recently");
  }
  const prompt = params.prompt?.toLowerCase() ?? "";
  const goal =
    `${thread.goal?.objective ?? ""} ${thread.title ?? ""} ${thread.preview ?? ""}`.toLowerCase();
  if (
    prompt &&
    goal &&
    prompt.split(/\s+/).filter((word) => word.length > 4 && goal.includes(word)).length >= 2
  ) {
    score += 20;
    reasons.push("goal text overlap");
  }
  return { thread, score, reasons };
}

function allowedClassesForVerbosity(
  verbosity: CodexBridgeWatchRecord["verbosity"],
): Set<CodexBridgeEventClass> {
  if (verbosity === "completion_only") {
    return new Set(["completion"]);
  }
  if (verbosity === "periodic_digest") {
    return new Set([
      "completion",
      "failure",
      "blocker",
      "approval_required",
      "auth_failure",
      "meaningful_progress",
    ]);
  }
  return new Set(["completion", "failure", "blocker", "approval_required", "auth_failure"]);
}

function isRepoAllowed(repoPath: string | undefined, allowedRepos: string[]): boolean {
  if (allowedRepos.length === 0) {
    return false;
  }
  if (!repoPath) {
    return false;
  }
  const resolvedRepo = path.resolve(repoPath);
  return allowedRepos.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    return (
      resolvedRepo === resolvedAllowed || resolvedRepo.startsWith(`${resolvedAllowed}${path.sep}`)
    );
  });
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && path.resolve(left) === path.resolve(right));
}

function reject(code: string, message: string, reasons: string[]): CodexBridgeWriteDecision {
  return { ok: false, code, message, reasons };
}
