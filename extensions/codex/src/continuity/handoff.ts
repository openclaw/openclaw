import { execFileSync } from "node:child_process";
import path from "node:path";
import { redactCodexBridgeText } from "./redaction.js";
import type { CodexBridgeSnapshot, CodexBridgeThread } from "./types.js";

export type CodexHandoffBrief = {
  markdown: string;
  observedFacts: string[];
  codexReportedClaims: string[];
  independentlyObservedEvidence: string[];
  blockers: string[];
  interpretation: string[];
  nextActions: string[];
};

export function buildCodexHandoffBrief(params: {
  snapshot: CodexBridgeSnapshot;
  threadId?: string;
  now?: Date;
}): CodexHandoffBrief {
  const now = params.now ?? new Date();
  const thread = selectThread(params.snapshot, params.threadId);
  const observedFacts = buildObservedFacts(thread, params.snapshot);
  const codexReportedClaims = buildReportedClaims(thread);
  const independentlyObservedEvidence = buildEvidence(thread);
  const blockers = buildBlockers(thread, params.snapshot);
  const interpretation = buildInterpretation(thread, params.snapshot);
  const nextActions = buildNextActions(thread, params.snapshot);
  const markdown = [
    "# Codex Handoff Brief",
    "",
    `Generated: ${now.toISOString()}`,
    "",
    "## Current Goal",
    "",
    redactCodexBridgeText(
      thread?.goal?.objective ?? thread?.title ?? "No active Codex goal observed.",
    ),
    "",
    "## Observed Facts",
    "",
    ...toBullets(observedFacts),
    "",
    "## Codex-Reported Claims",
    "",
    ...toBullets(
      codexReportedClaims.length
        ? codexReportedClaims
        : ["No final Codex claims were observed by the bridge."],
    ),
    "",
    "## Independently Observed Evidence",
    "",
    ...toBullets(independentlyObservedEvidence),
    "",
    "## Blockers",
    "",
    ...toBullets(blockers.length ? blockers : ["No blocker was observed by the bridge."]),
    "",
    "## OpenClawBrain Interpretation",
    "",
    ...toBullets(interpretation),
    "",
    "## Next Actions",
    "",
    ...nextActions.map((action, index) => `${index + 1}. ${action}`),
    "",
  ].join("\n");
  return {
    markdown,
    observedFacts,
    codexReportedClaims,
    independentlyObservedEvidence,
    blockers,
    interpretation,
    nextActions,
  };
}

function selectThread(
  snapshot: CodexBridgeSnapshot,
  threadId: string | undefined,
): CodexBridgeThread | undefined {
  if (threadId) {
    return snapshot.threads.find((thread) => thread.id === threadId);
  }
  return snapshot.activeThreads[0] ?? snapshot.latestThread;
}

function buildObservedFacts(
  thread: CodexBridgeThread | undefined,
  snapshot: CodexBridgeSnapshot,
): string[] {
  if (!thread) {
    return [
      `Source: ${snapshot.source}${snapshot.stale ? " (stale fallback)" : ""}`,
      "No Codex thread was selected.",
    ];
  }
  const facts = [
    `Source: ${snapshot.source}${snapshot.stale ? " (stale fallback)" : ""}`,
    `Thread: ${thread.id}`,
    `Status: ${thread.status}`,
  ];
  if (thread.cwd) {
    facts.push(`Repo: ${thread.cwd}`);
    facts.push(`Dirty files: ${readDirtyState(thread.cwd)}`);
  }
  if (thread.branch) {
    facts.push(`Branch: ${thread.branch}`);
  }
  if (thread.updatedAtMs) {
    facts.push(`Updated: ${new Date(thread.updatedAtMs).toISOString()}`);
  }
  if (thread.goal?.status) {
    facts.push(`Goal status: ${thread.goal.status}`);
  }
  return facts.map((line) => redactCodexBridgeText(line, 500));
}

function buildReportedClaims(thread: CodexBridgeThread | undefined): string[] {
  const claims: string[] = [];
  if (thread?.goal?.status === "complete") {
    claims.push("Codex goal status is complete according to local Codex state.");
  }
  if (thread?.preview) {
    claims.push(`Latest known prompt/title context: ${thread.preview}`);
  }
  return claims.map((line) => redactCodexBridgeText(line, 500));
}

function buildEvidence(thread: CodexBridgeThread | undefined): string[] {
  if (!thread) {
    return ["No thread evidence is available."];
  }
  const evidence = [`Thread row observed from ${thread.source}.`];
  if (thread.cwd) {
    evidence.push(`Git state checked for ${thread.cwd}.`);
  }
  evidence.push(
    "The bridge does not treat Codex final-answer claims as independently verified unless it observed supporting command output.",
  );
  return evidence.map((line) => redactCodexBridgeText(line, 600));
}

function buildBlockers(
  thread: CodexBridgeThread | undefined,
  snapshot: CodexBridgeSnapshot,
): string[] {
  const blockers: string[] = [];
  if (!snapshot.appServerStatus.available) {
    blockers.push(`Codex app-server unavailable: ${snapshot.appServerStatus.error ?? "unknown"}`);
  }
  if (snapshot.lastTelegramFailure) {
    blockers.push(`Telegram notification failure: ${snapshot.lastTelegramFailure}`);
  }
  if (thread?.status === "paused" || thread?.status === "budget_limited") {
    blockers.push(`Goal is ${thread.status}.`);
  }
  return blockers.map((line) => redactCodexBridgeText(line, 500));
}

function buildInterpretation(
  thread: CodexBridgeThread | undefined,
  snapshot: CodexBridgeSnapshot,
): string[] {
  if (!thread) {
    return [
      "OpenClawBrain should answer with a status overview rather than infer a single active Codex task.",
    ];
  }
  const lines = [
    "Codex UI remains the high-bandwidth workbench; Telegram should receive only concise operator summaries.",
  ];
  if (snapshot.stale) {
    lines.push(
      "This brief is based on stale read-only fallback state, so operational claims should be treated as lower authority.",
    );
  }
  if (thread.status === "active") {
    lines.push(
      "The current thread still appears active; a watch is more useful than repeated status polling.",
    );
  }
  if (thread.status === "complete") {
    lines.push("A completion summary is notify-worthy if this thread was explicitly watched.");
  }
  return lines;
}

function buildNextActions(
  thread: CodexBridgeThread | undefined,
  snapshot: CodexBridgeSnapshot,
): string[] {
  if (!thread) {
    return [
      "Ask `/codex threads` to select a recent thread.",
      "Create a watch only after choosing a target thread.",
    ];
  }
  if (!snapshot.appServerStatus.available) {
    return [
      "Open Codex UI or restart Codex app-server if fresh live status is required.",
      "Use the stale brief only as orientation.",
    ];
  }
  if (thread.status === "active") {
    return [
      "Keep the Telegram surface quiet until completion or blocker.",
      "Generate another handoff when returning to the Mac.",
    ];
  }
  return [
    "Review the Codex final answer in the UI.",
    "Verify tests or git state directly before publishing or deploying.",
  ];
}

function readDirtyState(cwd: string): string {
  try {
    const output = execFileSync("git", ["status", "--short"], {
      cwd: path.resolve(cwd),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const lines = output.split(/\r?\n/).filter(Boolean);
    return lines.length === 0 ? "clean" : `${lines.length} changed file(s)`;
  } catch {
    return "unknown";
  }
}

function toBullets(lines: string[]): string[] {
  return lines.map((line) => `- ${line}`);
}
