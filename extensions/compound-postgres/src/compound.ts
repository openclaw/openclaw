import type { ReplyPayload } from "openclaw/plugin-sdk";
import type pg from "pg";
import type { Logger } from "./db.js";
import { getPool } from "./db.js";

// ── Learning Capture ─────────────────────────────────────────────────────────

export interface Learning {
  sessionKey?: string;
  sessionId?: string;
  category: string;
  title: string;
  problem?: string;
  solution?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export async function insertLearning(pool: pg.Pool, learning: Learning): Promise<number> {
  const result = await pool.query(
    `INSERT INTO compound_learnings (
      session_key, session_id, category, title, problem, solution, tags, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    [
      learning.sessionKey ?? null,
      learning.sessionId ?? null,
      learning.category,
      learning.title,
      learning.problem ?? null,
      learning.solution ?? null,
      learning.tags,
      learning.metadata ? JSON.stringify(learning.metadata) : null,
    ],
  );
  return result.rows.at(0)?.id as number;
}

// ── Learning Retrieval ───────────────────────────────────────────────────────

interface RetrievedLearning {
  id: number;
  category: string;
  title: string;
  problem: string | null;
  solution: string | null;
  tags: string[];
  ts: Date;
  relevance_score: number;
}

export async function fetchRecentLearnings(pool: pg.Pool, limit = 5): Promise<RetrievedLearning[]> {
  const result = await pool.query(
    `SELECT id, category, title, problem, solution, tags, ts, relevance_score
     FROM compound_learnings
     ORDER BY (relevance_score * (1.0 / (EXTRACT(EPOCH FROM (NOW() - ts)) / 86400.0 + 1.0))) DESC,
              ts DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows as RetrievedLearning[];
}

export async function markInjected(pool: pg.Pool, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE compound_learnings
     SET times_injected = times_injected + 1,
         last_injected_at = NOW()
     WHERE id = ANY($1)`,
    [ids],
  );
}

// ── Format for Injection ─────────────────────────────────────────────────────

function formatLearningsContext(learnings: RetrievedLearning[]): string {
  if (learnings.length === 0) return "";

  const entries = learnings.map((l, i) => {
    const parts = [`${i + 1}. **${l.title}** [${l.category}]`];
    if (l.problem) parts.push(`   Problem: ${l.problem}`);
    if (l.solution) parts.push(`   Solution: ${l.solution}`);
    if (l.tags.length > 0) parts.push(`   Tags: ${l.tags.join(", ")}`);
    return parts.join("\n");
  });

  return [
    "---",
    "## Compound Learnings (from previous sessions)",
    "The following learnings were captured from prior work and may be relevant:",
    "",
    ...entries,
    "---",
  ].join("\n");
}

// ── Hook: Inject Learnings ──────────────────────────────────────────────────

export function createBeforeAgentStartHook(logger: Logger) {
  return async (
    _event: { prompt: string; messages?: unknown[] },
    _ctx: {
      agentId?: string;
      sessionKey?: string;
      workspaceDir?: string;
      messageProvider?: string;
    },
  ): Promise<{ prependContext?: string } | void> => {
    const pool = await getPool(logger);
    if (!pool) return;

    try {
      const learnings = await fetchRecentLearnings(pool);
      if (learnings.length === 0) return;

      const context = formatLearningsContext(learnings);
      const ids = learnings.map((l) => l.id);
      await markInjected(pool, ids);

      logger.info(`compound-postgres: injected ${learnings.length} learnings into session`);
      return { prependContext: context };
    } catch (err) {
      logger.warn(`compound-postgres: failed to fetch learnings: ${err}`);
    }
  };
}

// ── Command: /compound ──────────────────────────────────────────────────────

function parseLearningFromArgs(args: string): Learning | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  // Try JSON first
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Learning;
      if (!parsed.title || !parsed.category) return null;
      return {
        category: parsed.category,
        title: parsed.title,
        problem: parsed.problem,
        solution: parsed.solution,
        tags: parsed.tags ?? [],
        metadata: parsed.metadata,
      };
    } catch {
      return null;
    }
  }

  // Simple pipe-delimited format: category: title | problem | solution | tag1,tag2
  const segments = trimmed.split("|").map((s) => s.trim());
  if (segments.length < 1) return null;

  const header = segments.at(0) ?? "";
  const colonIdx = header.indexOf(":");
  if (colonIdx === -1) {
    return {
      category: "general",
      title: header,
      problem: segments.at(1) ?? undefined,
      solution: segments.at(2) ?? undefined,
      tags:
        segments
          .at(3)
          ?.split(",")
          .map((t) => t.trim()) ?? [],
    };
  }

  return {
    category: header.slice(0, colonIdx).trim(),
    title: header.slice(colonIdx + 1).trim(),
    problem: segments.at(1) ?? undefined,
    solution: segments.at(2) ?? undefined,
    tags:
      segments
        .at(3)
        ?.split(",")
        .map((t) => t.trim()) ?? [],
  };
}

export function createCompoundCommandHandler(logger: Logger) {
  return async (ctx: {
    senderId?: string;
    channel: string;
    args?: string;
  }): Promise<ReplyPayload> => {
    const pool = await getPool(logger);
    if (!pool) {
      return {
        text: "⚠️ compound-postgres: PostgreSQL not configured. Create ~/.openclaw/postgres-audit.json",
      };
    }

    const learning = parseLearningFromArgs(ctx.args ?? "");
    if (!learning) {
      return {
        text: [
          "📝 **Compound Learning** — capture a session learning",
          "",
          "**Usage:**",
          "`/compound category: title | problem | solution | tag1,tag2`",
          "",
          "**Or JSON:**",
          '`/compound {"category":"bug-fix","title":"...","problem":"...","solution":"...","tags":["a","b"]}`',
          "",
          "**Categories:** bug-fix, pattern, gotcha, optimization, architecture, general",
        ].join("\n"),
      };
    }

    try {
      learning.sessionKey = ctx.senderId;
      const id = await insertLearning(pool, learning);
      return {
        text: [
          `✅ Learning captured (id: ${id})`,
          `**${learning.title}** [${learning.category}]`,
          learning.tags.length > 0 ? `Tags: ${learning.tags.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    } catch (err) {
      logger.warn(`compound-postgres: compound insert failed: ${err}`);
      return { text: `⚠️ Failed to capture learning: ${err}` };
    }
  };
}
