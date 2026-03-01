import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const DEFAULT_HOT_USER_TURNS = 8;
const MAX_LIST_ITEMS = 6;
const MAX_ITEM_CHARS = 240;
const MAX_GOAL_CHARS = 320;

export type RollingContextSummary = {
  schemaVersion: 1;
  updatedAt: number;
  goal: string;
  constraints: string[];
  completed: string[];
  pending: string[];
  next: string[];
};

function normalizeLine(value: string | undefined): string {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > MAX_ITEM_CHARS
    ? `${trimmed.slice(0, MAX_ITEM_CHARS - 1).trimEnd()}…`
    : trimmed;
}

function uniqueList(items: string[], maxItems = MAX_LIST_ITEMS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = normalizeLine(item);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const normalized = normalizeLine(line);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function extractKeywordLines(text: string, pattern: RegExp, maxItems = MAX_LIST_ITEMS): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .filter((line) => pattern.test(line));
  return uniqueList(lines, maxItems);
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function isContextLayeringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OPENCLAW_CONTEXT_LAYERS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export function resolveHotContextTurns(env: NodeJS.ProcessEnv = process.env): number {
  return parseEnvInt(env.OPENCLAW_CONTEXT_HOT_TURNS, DEFAULT_HOT_USER_TURNS);
}

export function resolveRollingSummaryPath(sessionFile: string): string {
  const parsed = path.parse(sessionFile);
  return path.join(parsed.dir, `${parsed.name}.rolling-summary.json`);
}

export async function loadRollingContextSummary(
  sessionFile: string,
): Promise<RollingContextSummary | null> {
  const summaryPath = resolveRollingSummaryPath(sessionFile);
  try {
    const raw = await fs.readFile(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const goal = normalizeLine(typeof parsed.goal === "string" ? parsed.goal : "");
    if (!goal) {
      return null;
    }
    const updatedAtRaw = parsed.updatedAt;
    const updatedAt =
      typeof updatedAtRaw === "number" && Number.isFinite(updatedAtRaw) ? updatedAtRaw : Date.now();
    const summary: RollingContextSummary = {
      schemaVersion: 1,
      updatedAt,
      goal,
      constraints: uniqueList(toStringArray(parsed.constraints)),
      completed: uniqueList(toStringArray(parsed.completed)),
      pending: uniqueList(toStringArray(parsed.pending)),
      next: uniqueList(toStringArray(parsed.next)),
    };
    return summary;
  } catch {
    return null;
  }
}

export async function saveRollingContextSummary(
  sessionFile: string,
  summary: RollingContextSummary,
): Promise<void> {
  const summaryPath = resolveRollingSummaryPath(sessionFile);
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
}

function resolveGoal(existing: RollingContextSummary | null, prompt: string): string {
  const existingGoal = normalizeLine(existing?.goal);
  if (existingGoal) {
    return existingGoal;
  }
  const fromPrompt = firstNonEmptyLine(prompt);
  if (!fromPrompt) {
    return "Ongoing task";
  }
  return fromPrompt.length > MAX_GOAL_CHARS
    ? `${fromPrompt.slice(0, MAX_GOAL_CHARS - 1).trimEnd()}…`
    : fromPrompt;
}

function extractConstraints(prompt: string): string[] {
  return extractKeywordLines(
    prompt,
    /(must|should|constraint|require|only|never|不要|必须|约束|限制)/i,
    4,
  );
}

function extractNextHints(text: string): string[] {
  return extractKeywordLines(text, /(next|todo|follow-up|建议|下一步|待办|后续)/i, 3);
}

export function buildRollingContextSummary(params: {
  existing: RollingContextSummary | null;
  prompt: string;
  assistantReply: string;
  now?: number;
}): RollingContextSummary {
  const now = params.now ?? Date.now();
  const existing = params.existing;
  const goal = resolveGoal(existing, params.prompt);
  const constraints = uniqueList([
    ...(existing?.constraints ?? []),
    ...extractConstraints(params.prompt),
  ]);
  const lastOutcome = firstNonEmptyLine(params.assistantReply);
  const completed = uniqueList([
    ...(lastOutcome ? [`Last turn outcome: ${lastOutcome}`] : []),
    ...(existing?.completed ?? []),
  ]);
  const pending = uniqueList(existing?.pending ?? []);
  const next = uniqueList([
    ...extractNextHints(params.assistantReply),
    ...(existing?.next ?? []),
    ...(pending.length > 0 ? [pending[0]] : []),
  ]);

  return {
    schemaVersion: 1,
    updatedAt: now,
    goal,
    constraints,
    completed,
    pending,
    next,
  };
}

export async function updateRollingContextSummaryForTurn(params: {
  sessionFile: string;
  prompt: string;
  assistantReply: string;
  now?: number;
}): Promise<RollingContextSummary> {
  const existing = await loadRollingContextSummary(params.sessionFile);
  const next = buildRollingContextSummary({
    existing,
    prompt: params.prompt,
    assistantReply: params.assistantReply,
    now: params.now,
  });
  await saveRollingContextSummary(params.sessionFile, next);
  return next;
}

function renderList(title: string, items: string[]): string {
  if (items.length === 0) {
    return `${title}\n- (none)`;
  }
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function renderWarmSummary(summary: RollingContextSummary): string {
  return [
    "[Warm Context Summary]",
    `Goal: ${summary.goal}`,
    renderList("Constraints:", summary.constraints),
    renderList("Completed:", summary.completed),
    renderList("Pending:", summary.pending),
    renderList("Next:", summary.next),
  ].join("\n");
}

function resolveHotStartIndex(messages: AgentMessage[], keepHotUserTurns: number): number {
  if (keepHotUserTurns <= 0) {
    return 0;
  }
  const userIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") {
      userIndexes.push(i);
    }
  }
  if (userIndexes.length <= keepHotUserTurns) {
    return 0;
  }
  return userIndexes[userIndexes.length - keepHotUserTurns] ?? 0;
}

export function applyContextLayering(params: {
  messages: AgentMessage[];
  summary: RollingContextSummary | null;
  keepHotUserTurns: number;
}): { messages: AgentMessage[]; applied: boolean; coldMessageCount: number } {
  const { messages, summary, keepHotUserTurns } = params;
  if (!summary || messages.length === 0) {
    return { messages, applied: false, coldMessageCount: 0 };
  }
  const hotStart = resolveHotStartIndex(messages, keepHotUserTurns);
  if (hotStart <= 0) {
    return { messages, applied: false, coldMessageCount: 0 };
  }
  const hotMessages = messages.slice(hotStart);
  if (hotMessages.length === 0) {
    return { messages, applied: false, coldMessageCount: 0 };
  }

  // Keep old history as cold context by replacing it with a compact warm summary block.
  const warmSummaryMessage = {
    role: "system",
    content: renderWarmSummary(summary),
  } as unknown as AgentMessage;

  return {
    messages: [warmSummaryMessage, ...hotMessages],
    applied: true,
    coldMessageCount: hotStart,
  };
}

export function pickAssistantReplyForSummary(params: {
  payloads: Array<{ text?: string; isError?: boolean }>;
  assistantTexts?: string[];
}): string {
  const payloadCandidate = params.payloads
    .toReversed()
    .find((payload) => !payload.isError && typeof payload.text === "string" && payload.text.trim());
  if (payloadCandidate?.text) {
    return payloadCandidate.text.trim();
  }
  const assistantCandidate = (params.assistantTexts ?? [])
    .toReversed()
    .find((text) => typeof text === "string" && text.trim());
  return assistantCandidate?.trim() ?? "";
}
