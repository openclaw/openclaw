import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const BEAM_HOST_ID = "gateway";
export const BEAM_MAX_BODY_BYTES = 56 * 1024;
export const BEAM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BEAM_MAX_SESSIONS = 500;
const BEAM_MAX_ITEMS = 200;
const BEAM_MAX_ITEM_CHARS = 6_000;

type BeamTranscriptItem = {
  type: "userMessage" | "agentMessage" | "other";
  text: string;
};

type BeamUpload = {
  version: 1;
  beamId: string;
  source: string;
  title: string;
  updatedAt: string;
  completed: boolean;
  truncated?: boolean;
  hookEvent?: string;
  items: BeamTranscriptItem[];
};

export type BeamStoredSession = BeamUpload & {
  createdAt: number;
  receivedAt: number;
};

const TOP_LEVEL_KEYS = new Set([
  "version",
  "beamId",
  "source",
  "title",
  "updatedAt",
  "completed",
  "truncated",
  "hookEvent",
  "items",
]);
const ITEM_KEYS = new Set(["type", "text"]);
const ITEM_TYPES = new Set<BeamTranscriptItem["type"]>(["userMessage", "agentMessage", "other"]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

export function parseBeamUpload(
  value: unknown,
): { ok: true; value: BeamUpload } | { ok: false; error: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, TOP_LEVEL_KEYS)) {
    return { ok: false, error: "request body must be a closed Beam object" };
  }
  if (value.version !== 1) {
    return { ok: false, error: "version must be 1" };
  }
  const beamId = optionalString(value.beamId, 64);
  if (!beamId || !/^[a-f0-9]{32}$/i.test(beamId)) {
    return { ok: false, error: "beamId must be a 32-character hex id" };
  }
  const source = optionalString(value.source, 32);
  if (!source || !/^[a-z0-9._-]+$/i.test(source)) {
    return { ok: false, error: "source must be a short identifier" };
  }
  const title = optionalString(value.title, 160);
  if (!title) {
    return { ok: false, error: "title must be a non-empty string" };
  }
  const updatedAt = optionalString(value.updatedAt, 64);
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
    return { ok: false, error: "updatedAt must be an ISO timestamp" };
  }
  if (typeof value.completed !== "boolean") {
    return { ok: false, error: "completed must be a boolean" };
  }
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    return { ok: false, error: "truncated must be a boolean" };
  }
  const hookEvent = value.hookEvent === undefined ? undefined : optionalString(value.hookEvent, 64);
  if (value.hookEvent !== undefined && !hookEvent) {
    return { ok: false, error: "hookEvent must be a short string" };
  }
  if (
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > BEAM_MAX_ITEMS
  ) {
    return { ok: false, error: `items must contain 1-${BEAM_MAX_ITEMS} entries` };
  }
  const items: BeamTranscriptItem[] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem) || !hasOnlyKeys(rawItem, ITEM_KEYS)) {
      return { ok: false, error: "each transcript item must be a closed object" };
    }
    if (
      typeof rawItem.type !== "string" ||
      !ITEM_TYPES.has(rawItem.type as BeamTranscriptItem["type"])
    ) {
      return { ok: false, error: "transcript item type is invalid" };
    }
    const text = optionalString(rawItem.text, BEAM_MAX_ITEM_CHARS);
    if (!text) {
      return {
        ok: false,
        error: `transcript item text must be 1-${BEAM_MAX_ITEM_CHARS} characters`,
      };
    }
    items.push({ type: rawItem.type as BeamTranscriptItem["type"], text });
  }

  return {
    ok: true,
    value: {
      version: 1,
      beamId: beamId.toLowerCase(),
      source: source.toLowerCase(),
      title,
      updatedAt,
      completed: value.completed,
      ...(value.truncated === true ? { truncated: true } : {}),
      ...(hookEvent ? { hookEvent } : {}),
      items,
    },
  };
}
