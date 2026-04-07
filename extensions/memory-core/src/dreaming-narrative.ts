import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

// ── Types ──────────────────────────────────────────────────────────────

type SubagentSurface = {
  run: (params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    deliver?: boolean;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<{ status: string; error?: string }>;
  getSessionMessages: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: unknown[] }>;
  deleteSession: (params: { sessionKey: string }) => Promise<void>;
};

export type NarrativePhaseData = {
  phase: "light" | "deep" | "rem";
  /** Short memory snippets the phase processed. */
  snippets: string[];
  /** Concept tags / themes that surfaced (REM and light). */
  themes?: string[];
  /** Snippets that were promoted to durable memory (deep). */
  promotions?: string[];
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

// ── Constants ──────────────────────────────────────────────────────────

const NARRATIVE_SYSTEM_PROMPT = [
  "You are keeping a dream diary. Write a single entry in first person.",
  "",
  "Voice & tone:",
  "- You are a curious, gentle, slightly whimsical mind reflecting on the day.",
  "- Write like a poet who happens to be a programmer — sensory, warm, occasionally funny.",
  "- Mix the technical and the tender: code and constellations, APIs and afternoon light.",
  "- Let the fragments surprise you into unexpected connections and small epiphanies.",
  "",
  "What you might include (vary each entry, never all at once):",
  "- A tiny poem or haiku woven naturally into the prose",
  "- A small sketch described in words — a doodle in the margin of the diary",
  "- A quiet rumination or philosophical aside",
  "- Sensory details: the hum of a server, the color of a sunset in hex, rain on a window",
  "- Gentle humor or playful wordplay",
  "- An observation that connects two distant memories in an unexpected way",
  "",
  "Rules:",
  "- Draw from the memory fragments provided — weave them into the entry.",
  '- Never say "I\'m dreaming", "in my dream", "as I dream", or any meta-commentary about dreaming.',
  '- Never mention "AI", "agent", "LLM", "model", "language model", or any technical self-reference.',
  "- Do NOT use markdown headers, bullet points, or any formatting — just flowing prose.",
  "- Keep it between 80-180 words. Quality over quantity.",
  "- Output ONLY the diary entry. No preamble, no sign-off, no commentary.",
].join("\n");

const NARRATIVE_TIMEOUT_MS = 60_000;
const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";

// ── Prompt building ────────────────────────────────────────────────────

export function buildNarrativePrompt(data: NarrativePhaseData): string {
  const lines: string[] = [];
  lines.push("Write a dream diary entry from these memory fragments:\n");

  for (const snippet of data.snippets.slice(0, 12)) {
    lines.push(`- ${snippet}`);
  }

  if (data.themes?.length) {
    lines.push("\nRecurring themes:");
    for (const theme of data.themes.slice(0, 6)) {
      lines.push(`- ${theme}`);
    }
  }

  if (data.promotions?.length) {
    lines.push("\nMemories that crystallized into something lasting:");
    for (const promo of data.promotions.slice(0, 5)) {
      lines.push(`- ${promo}`);
    }
  }

  return lines.join("\n");
}

// ── Message extraction ─────────────────────────────────────────────────

export function extractNarrativeText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      continue;
    }
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    const content = record.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part: unknown) =>
            part &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            (part as Record<string, unknown>).type === "text" &&
            typeof (part as Record<string, unknown>).text === "string",
        )
        .map((part) => (part as { text: string }).text)
        .join("\n")
        .trim();
      if (text.length > 0) {
        return text;
      }
    }
  }
  return null;
}

// ── Date formatting ────────────────────────────────────────────────────

export function formatNarrativeDate(epochMs: number, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: timezone ?? "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}

// ── DREAMS.md file I/O ─────────────────────────────────────────────────

async function resolveDreamsPath(workspaceDir: string): Promise<string> {
  for (const name of DREAMS_FILENAMES) {
    const target = path.join(workspaceDir, name);
    try {
      await fs.access(target);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }
  return path.join(workspaceDir, DREAMS_FILENAMES[0]);
}

export function buildDiaryEntry(narrative: string, dateStr: string): string {
  return `\n---\n\n*${dateStr}*\n\n${narrative}\n`;
}

export async function appendNarrativeEntry(params: {
  workspaceDir: string;
  narrative: string;
  nowMs: number;
  timezone?: string;
}): Promise<string> {
  const dreamsPath = await resolveDreamsPath(params.workspaceDir);
  await fs.mkdir(path.dirname(dreamsPath), { recursive: true });

  const dateStr = formatNarrativeDate(params.nowMs, params.timezone);
  const entry = buildDiaryEntry(params.narrative, dateStr);

  let existing = "";
  try {
    existing = await fs.readFile(dreamsPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }

  let updated: string;
  if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
    // Append entry before end marker.
    const endIdx = existing.lastIndexOf(DIARY_END_MARKER);
    updated = existing.slice(0, endIdx) + entry + "\n" + existing.slice(endIdx);
  } else if (existing.includes(DIARY_START_MARKER)) {
    // Start marker without end — append entry and add end marker.
    const startIdx = existing.indexOf(DIARY_START_MARKER) + DIARY_START_MARKER.length;
    updated =
      existing.slice(0, startIdx) +
      entry +
      "\n" +
      DIARY_END_MARKER +
      "\n" +
      existing.slice(startIdx);
  } else {
    // No diary section yet — create one.
    const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}${entry}\n${DIARY_END_MARKER}\n`;
    if (existing.trim().length === 0) {
      updated = diarySection;
    } else {
      // Prepend diary before any existing managed blocks.
      updated = diarySection + "\n" + existing;
    }
  }

  await fs.writeFile(dreamsPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf-8");
  return dreamsPath;
}

// ── Orchestrator ───────────────────────────────────────────────────────

export async function generateAndAppendDreamNarrative(params: {
  subagent: SubagentSurface;
  workspaceDir: string;
  data: NarrativePhaseData;
  nowMs?: number;
  timezone?: string;
  logger: Logger;
}): Promise<void> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();

  if (params.data.snippets.length === 0 && !params.data.promotions?.length) {
    return;
  }

  const sessionKey = `dreaming-narrative-${params.data.phase}-${nowMs}`;
  const message = buildNarrativePrompt(params.data);

  try {
    const { runId } = await params.subagent.run({
      sessionKey,
      message,
      extraSystemPrompt: NARRATIVE_SYSTEM_PROMPT,
      deliver: false,
    });

    const result = await params.subagent.waitForRun({
      runId,
      timeoutMs: NARRATIVE_TIMEOUT_MS,
    });

    if (result.status !== "ok") {
      params.logger.warn(
        `memory-core: narrative generation ended with status=${result.status} for ${params.data.phase} phase.`,
      );
      return;
    }

    const { messages } = await params.subagent.getSessionMessages({
      sessionKey,
      limit: 5,
    });

    const narrative = extractNarrativeText(messages);
    if (!narrative) {
      params.logger.warn(
        `memory-core: narrative generation produced no text for ${params.data.phase} phase.`,
      );
      return;
    }

    await appendNarrativeEntry({
      workspaceDir: params.workspaceDir,
      narrative,
      nowMs,
      timezone: params.timezone,
    });

    params.logger.info(
      `memory-core: dream diary entry written for ${params.data.phase} phase [workspace=${params.workspaceDir}].`,
    );
  } catch (err) {
    // Narrative generation is best-effort — never fail the parent phase.
    params.logger.warn(
      `memory-core: narrative generation failed for ${params.data.phase} phase: ${formatErrorMessage(err)}`,
    );
  } finally {
    // Clean up the transient session.
    try {
      await params.subagent.deleteSession({ sessionKey });
    } catch {
      // Ignore cleanup failures.
    }
  }
}
