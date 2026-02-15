import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";

const SUMMARY_VERSION = 1;
const DEFAULT_MAX_ITEMS = 60;
const DEFAULT_MAX_ITEM_CHARS = 220;
const DEFAULT_MAX_PROMPT_CHARS = 1200;

export type SessionSummaryState = {
  version: number;
  lastProcessedMessageCount: number;
  items: string[];
  updatedAt: number;
};

function createEmptyState(): SessionSummaryState {
  return {
    version: SUMMARY_VERSION,
    lastProcessedMessageCount: 0,
    items: [],
    updatedAt: Date.now(),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, Math.max(0, maxChars));
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function extractMessageText(message: AgentMessage): string | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  if (typeof message.content === "string") {
    const normalized = normalizeText(message.content);
    return normalized || null;
  }

  if (!Array.isArray(message.content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
      const normalized = normalizeText(typedBlock.text);
      if (normalized) {
        textParts.push(normalized);
      }
    }
  }

  if (textParts.length === 0) {
    return null;
  }
  return textParts.join(" ");
}

function summarizeMessage(message: AgentMessage): string | null {
  const text = extractMessageText(message);
  if (!text) {
    return null;
  }
  const prefix = message.role === "user" ? "User" : "Assistant";
  return `${prefix}: ${truncateText(text, DEFAULT_MAX_ITEM_CHARS)}`;
}

function normalizeState(raw: unknown): SessionSummaryState {
  if (!raw || typeof raw !== "object") {
    return createEmptyState();
  }
  const record = raw as Partial<SessionSummaryState>;
  const items = Array.isArray(record.items)
    ? record.items.filter((item): item is string => typeof item === "string")
    : [];
  const lastProcessedMessageCount =
    typeof record.lastProcessedMessageCount === "number" &&
    Number.isFinite(record.lastProcessedMessageCount) &&
    record.lastProcessedMessageCount >= 0
      ? Math.floor(record.lastProcessedMessageCount)
      : 0;
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now();

  return {
    version: SUMMARY_VERSION,
    lastProcessedMessageCount,
    items,
    updatedAt,
  };
}

export function getSessionSummaryStatePath(sessionFile: string): string {
  return `${sessionFile}.summary.json`;
}

export async function loadSessionSummaryState(params: {
  sessionFile: string;
}): Promise<SessionSummaryState> {
  const statePath = getSessionSummaryStatePath(params.sessionFile);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return createEmptyState();
  }
}

export function updateSessionSummaryState(params: {
  state: SessionSummaryState;
  messages: AgentMessage[];
  maxItems?: number;
}): SessionSummaryState {
  const maxItems = Math.max(1, Math.floor(params.maxItems ?? DEFAULT_MAX_ITEMS));
  const safeStart = Math.max(
    0,
    Math.min(params.state.lastProcessedMessageCount, params.messages.length),
  );
  if (safeStart >= params.messages.length) {
    return params.state;
  }

  const additions: string[] = [];
  for (const message of params.messages.slice(safeStart)) {
    const summarized = summarizeMessage(message);
    if (!summarized) {
      continue;
    }
    if (params.state.items[params.state.items.length - 1] === summarized) {
      continue;
    }
    additions.push(summarized);
  }

  const merged =
    additions.length > 0
      ? [...params.state.items, ...additions].slice(-maxItems)
      : params.state.items.slice(-maxItems);
  return {
    ...params.state,
    items: merged,
    lastProcessedMessageCount: params.messages.length,
    updatedAt: Date.now(),
  };
}

export function buildSessionSummaryPrompt(params: {
  state: SessionSummaryState;
  maxChars?: number;
}): string | null {
  if (params.state.items.length === 0) {
    return null;
  }
  const maxChars = Math.max(1, Math.floor(params.maxChars ?? DEFAULT_MAX_PROMPT_CHARS));
  const header = [
    "[SESSION_SUMMARY]",
    "Use this as compressed prior context; prioritize direct transcript turns when present.",
  ].join("\n");
  if (header.length >= maxChars) {
    return truncateText(header, maxChars);
  }

  const keptItems: string[] = [];
  let totalChars = header.length + 1;
  for (const item of [...params.state.items].toReversed()) {
    const line = `- ${item}`;
    const projected = totalChars + line.length + 1;
    if (projected > maxChars) {
      break;
    }
    keptItems.push(line);
    totalChars = projected;
  }

  if (keptItems.length === 0) {
    return truncateText(header, maxChars);
  }
  keptItems.reverse();
  return `${header}\n${keptItems.join("\n")}`;
}

export async function persistSessionSummaryState(params: {
  sessionFile: string;
  state: SessionSummaryState;
}): Promise<void> {
  const statePath = getSessionSummaryStatePath(params.sessionFile);
  const payload = {
    version: SUMMARY_VERSION,
    lastProcessedMessageCount: Math.max(0, Math.floor(params.state.lastProcessedMessageCount)),
    items: params.state.items.slice(),
    updatedAt: Date.now(),
  };
  await fs.writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}
