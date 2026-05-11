import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readDurableJsonFile, writeJsonAtomic } from "../infra/json-files.js";

export type ActionQueueStatus = "open" | "in_progress" | "done" | "dismissed";
export type ActionQueueListStatus = ActionQueueStatus | "all";
export type ActionQueuePriority = "low" | "normal" | "high" | "urgent";
export type ActionQueueKind =
  | "approval"
  | "draft"
  | "followup"
  | "fix"
  | "idea"
  | "sync"
  | "message"
  | "system";
export type ActionQueueSource =
  | "manual"
  | "cron"
  | "notion"
  | "talk"
  | "canvas"
  | "bluebubbles"
  | "system";

export interface ActionQueueItem {
  id: string;
  title: string;
  caption?: string;
  kind: ActionQueueKind;
  source: ActionQueueSource;
  priority: ActionQueuePriority;
  status: ActionQueueStatus;
  createdAtMs: number;
  updatedAtMs: number;
  dueAtMs?: number;
  actionLabel?: string;
  payload?: Record<string, unknown>;
}

export interface ActionQueueAddInput {
  title: string;
  caption?: string;
  kind?: ActionQueueKind;
  source?: ActionQueueSource;
  priority?: ActionQueuePriority;
  dueAtMs?: number;
  actionLabel?: string;
  payload?: Record<string, unknown>;
  nowMs?: number;
}

export interface ActionQueueUpdateInput {
  id: string;
  patch: Partial<
    Pick<
      ActionQueueItem,
      | "title"
      | "caption"
      | "kind"
      | "source"
      | "priority"
      | "status"
      | "dueAtMs"
      | "actionLabel"
      | "payload"
    >
  >;
  nowMs?: number;
}

export interface ActionQueueListInput {
  status?: ActionQueueListStatus;
  source?: ActionQueueSource;
  limit?: number;
}

interface ActionQueueFile {
  version: 1;
  items: ActionQueueItem[];
}

const MAX_ITEMS = 200;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

let withQueueLock = createAsyncLock();

function resolveActionQueuePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "actions", "queue.json");
}

function compactText(value: unknown, field: string, required = false): string | undefined {
  if (typeof value !== "string") {
    if (required) {
      throw new Error(`${field} is required`);
    }
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      throw new Error(`${field} is required`);
    }
    return undefined;
  }
  return trimmed;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
  field: string,
): T {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string" && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${field} must be one of: ${values.join(", ")}`);
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return Math.trunc(value);
}

function optionalPayload(value: unknown): Record<string, unknown> | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("payload must be an object");
  }
  return value as Record<string, unknown>;
}

function limitValue(value: unknown): number {
  if (value == null) {
    return DEFAULT_LIMIT;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("limit must be a finite number");
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

async function readQueueFile(): Promise<ActionQueueFile> {
  const file = await readDurableJsonFile<ActionQueueFile>(resolveActionQueuePath());
  if (!file || !Array.isArray(file.items)) {
    return { version: 1, items: [] };
  }
  return {
    version: 1,
    items: file.items.filter(
      (item) => typeof item?.id === "string" && typeof item?.title === "string",
    ),
  };
}

async function writeQueueFile(file: ActionQueueFile): Promise<void> {
  await writeJsonAtomic(
    resolveActionQueuePath(),
    {
      version: 1,
      items: file.items.slice(0, MAX_ITEMS),
    },
    { trailingNewline: true },
  );
}

const statuses = ["open", "in_progress", "done", "dismissed"] as const;
const listStatuses = ["open", "in_progress", "done", "dismissed", "all"] as const;
const priorities = ["low", "normal", "high", "urgent"] as const;
const kinds = [
  "approval",
  "draft",
  "followup",
  "fix",
  "idea",
  "sync",
  "message",
  "system",
] as const;
const sources = ["manual", "cron", "notion", "talk", "canvas", "bluebubbles", "system"] as const;

export async function addActionQueueItem(input: ActionQueueAddInput): Promise<ActionQueueItem> {
  const title = compactText(input.title, "title", true)!;
  const caption = compactText(input.caption, "caption");
  const actionLabel = compactText(input.actionLabel, "actionLabel");
  const now = input.nowMs ?? Date.now();
  const item: ActionQueueItem = {
    id: randomUUID(),
    title,
    ...(caption ? { caption } : {}),
    kind: enumValue(input.kind, kinds, "followup", "kind"),
    source: enumValue(input.source, sources, "manual", "source"),
    priority: enumValue(input.priority, priorities, "normal", "priority"),
    status: "open",
    createdAtMs: now,
    updatedAtMs: now,
    ...(input.dueAtMs == null ? {} : { dueAtMs: optionalFiniteNumber(input.dueAtMs, "dueAtMs") }),
    ...(actionLabel ? { actionLabel } : {}),
    ...(input.payload ? { payload: optionalPayload(input.payload) } : {}),
  };

  return withQueueLock(async () => {
    const file = await readQueueFile();
    file.items.unshift(item);
    await writeQueueFile(file);
    return item;
  });
}

export async function updateActionQueueItem(
  input: ActionQueueUpdateInput,
): Promise<ActionQueueItem> {
  const id = compactText(input.id, "id", true)!;
  return withQueueLock(async () => {
    const file = await readQueueFile();
    const index = file.items.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new Error("action queue item not found");
    }
    const current = file.items[index]!;
    const patch = input.patch;
    const next: ActionQueueItem = {
      ...current,
      ...(patch.title !== undefined ? { title: compactText(patch.title, "title", true)! } : {}),
      ...(patch.caption !== undefined ? { caption: compactText(patch.caption, "caption") } : {}),
      ...(patch.kind !== undefined
        ? { kind: enumValue(patch.kind, kinds, current.kind, "kind") }
        : {}),
      ...(patch.source !== undefined
        ? { source: enumValue(patch.source, sources, current.source, "source") }
        : {}),
      ...(patch.priority !== undefined
        ? { priority: enumValue(patch.priority, priorities, current.priority, "priority") }
        : {}),
      ...(patch.status !== undefined
        ? { status: enumValue(patch.status, statuses, current.status, "status") }
        : {}),
      ...(patch.dueAtMs !== undefined
        ? { dueAtMs: optionalFiniteNumber(patch.dueAtMs, "dueAtMs") }
        : {}),
      ...(patch.actionLabel !== undefined
        ? { actionLabel: compactText(patch.actionLabel, "actionLabel") }
        : {}),
      ...(patch.payload !== undefined ? { payload: optionalPayload(patch.payload) } : {}),
      updatedAtMs: input.nowMs ?? Date.now(),
    };
    if (patch.caption !== undefined && next.caption === undefined) {
      delete next.caption;
    }
    if (patch.dueAtMs !== undefined && next.dueAtMs === undefined) {
      delete next.dueAtMs;
    }
    if (patch.actionLabel !== undefined && next.actionLabel === undefined) {
      delete next.actionLabel;
    }
    if (patch.payload !== undefined && next.payload === undefined) {
      delete next.payload;
    }
    file.items[index] = next;
    await writeQueueFile(file);
    return next;
  });
}

export async function listActionQueueItems(
  input: ActionQueueListInput = {},
): Promise<{ items: ActionQueueItem[] }> {
  const status = enumValue(input.status, listStatuses, "open", "status");
  const source =
    input.source == null ? undefined : enumValue(input.source, sources, "manual", "source");
  const limit = limitValue(input.limit);
  const file = await readQueueFile();
  const items = file.items
    .filter((item) => status === "all" || item.status === status)
    .filter((item) => source == null || item.source === source)
    .toSorted((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, limit);
  return { items };
}

export function resetActionQueueStoreForTest(): void {
  withQueueLock = createAsyncLock();
}
