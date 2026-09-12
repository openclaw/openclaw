import type { Generated, Selectable } from "openclaw/plugin-sdk/sqlite-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  LogbookBatch,
  LogbookBatchStatus,
  LogbookCard,
  LogbookDistraction,
  LogbookFrame,
} from "./types.js";

export const LOGBOOK_SCHEMA_VERSION = 1;

export type LogbookDatabase = {
  frames: {
    id: Generated<number>;
    captured_at_ms: number;
    day: string;
    path: string;
    screen_index: number;
    width: number | null;
    height: number | null;
    byte_size: number;
    content_hash: string;
    idle: number;
    batch_id: number | null;
  };
  batches: {
    id: Generated<number>;
    day: string;
    start_ms: number;
    end_ms: number;
    status: LogbookBatchStatus;
    error: string | null;
    frame_count: number;
    model: string | null;
    created_ms: number;
    updated_ms: number;
  };
  observations: {
    id: Generated<number>;
    batch_id: number;
    day: string;
    start_ms: number;
    end_ms: number;
    text: string;
  };
  cards: {
    id: Generated<number>;
    day: string;
    start_ms: number;
    end_ms: number;
    title: string;
    summary: string;
    detail: string;
    category: string;
    app_primary: string | null;
    app_secondary: string | null;
    distractions: string;
    keyframe_id: number | null;
    updated_ms: number;
  };
  standups: { day: string; text: string; updated_ms: number };
};

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  error TEXT,
  frame_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_batches_day ON batches (day, start_ms);
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at_ms INTEGER NOT NULL,
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  screen_index INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  idle INTEGER NOT NULL DEFAULT 0 CHECK (idle IN (0, 1)),
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_frames_day ON frames (day, captured_at_ms);
CREATE INDEX IF NOT EXISTS idx_logbook_frames_captured_at ON frames (captured_at_ms);
CREATE INDEX IF NOT EXISTS idx_logbook_frames_unbatched ON frames (batch_id) WHERE batch_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_logbook_frames_batch ON frames (batch_id, captured_at_ms) WHERE batch_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_observations_day ON observations (day, start_ms);
CREATE INDEX IF NOT EXISTS idx_logbook_observations_batch ON observations (batch_id);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  app_primary TEXT,
  app_secondary TEXT,
  distractions TEXT NOT NULL DEFAULT '[]',
  keyframe_id INTEGER REFERENCES frames(id) ON DELETE SET NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_cards_day ON cards (day, start_ms);
CREATE INDEX IF NOT EXISTS idx_logbook_cards_keyframe ON cards (keyframe_id) WHERE keyframe_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS standups (
  day TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
`;

type FrameRow = Omit<Selectable<LogbookDatabase["frames"]>, "content_hash" | "batch_id">;
type BatchRow = Omit<Selectable<LogbookDatabase["batches"]>, "created_ms" | "updated_ms">;

export function toFrame(row: FrameRow): LogbookFrame {
  return {
    id: row.id,
    capturedAtMs: row.captured_at_ms,
    day: row.day,
    path: row.path,
    screenIndex: row.screen_index,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    byteSize: row.byte_size,
    idle: row.idle === 1,
  };
}

export function toBatch(row: BatchRow): LogbookBatch {
  return {
    id: row.id,
    day: row.day,
    startMs: row.start_ms,
    endMs: row.end_ms,
    status: row.status,
    error: row.error ?? undefined,
    frameCount: row.frame_count,
    model: row.model ?? undefined,
  };
}

function parseDistractions(raw: string): LogbookDistraction[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry: unknown): entry is LogbookDistraction => {
      const record = asOptionalObjectRecord(entry);
      return (
        record !== undefined &&
        typeof record.title === "string" &&
        typeof record.startMs === "number" &&
        typeof record.endMs === "number"
      );
    });
  } catch {
    return [];
  }
}

export function toCard(row: Selectable<LogbookDatabase["cards"]>): LogbookCard {
  return {
    id: row.id,
    day: row.day,
    startMs: row.start_ms,
    endMs: row.end_ms,
    title: row.title,
    summary: row.summary,
    detail: row.detail,
    category: row.category,
    appPrimary: row.app_primary ?? undefined,
    appSecondary: row.app_secondary ?? undefined,
    distractions: parseDistractions(row.distractions),
    keyframeId: row.keyframe_id ?? undefined,
  };
}
