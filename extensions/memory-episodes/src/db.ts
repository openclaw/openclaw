/**
 * Episode Database Client (Postgres + pgvector)
 *
 * All queries use parameterized values ($1, $2, ...) to prevent SQL injection.
 * Graceful degradation: callers should catch and log errors rather than crash.
 */

import type { Pool as PgPool, PoolClient } from "pg";

// Lazy-load pg to avoid import failures when the package is optional
let pgImportPromise: Promise<typeof import("pg")> | null = null;
async function loadPg(): Promise<typeof import("pg")> {
  if (!pgImportPromise) {
    pgImportPromise = import("pg");
  }
  return pgImportPromise;
}

export type EpisodeRow = {
  episodeId: string;
  sourceSessionId: string;
  sourceSessionKey: string | null;
  userId: string;
  agentId: string;
  channelId: string | null;
  summary: string;
  keyDecisions: string[];
  filesTouched: string[];
  tasksCompleted: string[];
  tasksPending: string[];
  errorsEncountered: string[];
  startedAt: Date | null;
  endedAt: Date;
  sessionDurationM: number | null;
  messageCount: number | null;
  totalTokensUsed: number | null;
  summaryEmbedding: number[];
  createdAt: Date;
};

export type EpisodeInsert = {
  sourceSessionId: string;
  sourceSessionKey?: string;
  userId: string;
  agentId: string;
  channelId?: string;
  summary: string;
  keyDecisions: string[];
  filesTouched: string[];
  tasksCompleted: string[];
  tasksPending: string[];
  errorsEncountered: string[];
  startedAt?: Date;
  endedAt: Date;
  sessionDurationM?: number;
  messageCount?: number;
  totalTokensUsed?: number;
  summaryEmbedding: number[];
};

export type EpisodeSearchResult = {
  episode: EpisodeRow;
  similarity: number;
};

export type EpisodeStats = {
  totalEpisodes: number;
  latestEpisodeAt: Date | null;
  oldestEpisodeAt: Date | null;
};

function rowToEpisode(row: Record<string, unknown>): EpisodeRow {
  return {
    episodeId: row.episode_id as string,
    sourceSessionId: row.source_session_id as string,
    sourceSessionKey: (row.source_session_key as string) ?? null,
    userId: row.user_id as string,
    agentId: row.agent_id as string,
    channelId: (row.channel_id as string) ?? null,
    summary: row.summary as string,
    keyDecisions: (row.key_decisions as string[]) ?? [],
    filesTouched: (row.files_touched as string[]) ?? [],
    tasksCompleted: (row.tasks_completed as string[]) ?? [],
    tasksPending: (row.tasks_pending as string[]) ?? [],
    errorsEncountered: (row.errors_encountered as string[]) ?? [],
    startedAt: row.started_at ? new Date(row.started_at as string) : null,
    endedAt: new Date(row.ended_at as string),
    sessionDurationM: (row.session_duration_m as number) ?? null,
    messageCount: (row.message_count as number) ?? null,
    totalTokensUsed: (row.total_tokens_used as number) ?? null,
    summaryEmbedding: row.summary_embedding as number[],
    createdAt: new Date(row.created_at as string),
  };
}

// Format a number[] as a pgvector literal: "[0.1,0.2,...]"
function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class EpisodeDb {
  private pool: PgPool | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {}

  private async ensurePool(): Promise<PgPool> {
    if (this.pool) {
      return this.pool;
    }
    if (this.initPromise) {
      await this.initPromise;
      return this.pool!;
    }
    this.initPromise = this.doInit();
    await this.initPromise;
    return this.pool!;
  }

  private async doInit(): Promise<void> {
    const pg = await loadPg();
    // pg default export is the Pool constructor in CJS; in ESM it's pg.default.Pool
    const PoolCtor = (pg as Record<string, unknown>).Pool ?? pg.default?.Pool;
    if (!PoolCtor) {
      throw new Error("memory-episodes: could not resolve pg.Pool constructor");
    }
    this.pool = new (PoolCtor as new (opts: { connectionString: string }) => PgPool)({
      connectionString: this.connectionString,
    });
  }

  /** Run the schema migration (idempotent). Call once at startup. */
  async ensureSchema(): Promise<void> {
    const pool = await this.ensurePool();
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS episodes (
        episode_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_session_id     TEXT NOT NULL UNIQUE,
        source_session_key    TEXT,
        user_id               TEXT NOT NULL,
        agent_id              TEXT NOT NULL,
        channel_id            TEXT,
        summary               TEXT NOT NULL,
        key_decisions         JSONB NOT NULL DEFAULT '[]',
        files_touched         JSONB NOT NULL DEFAULT '[]',
        tasks_completed       JSONB NOT NULL DEFAULT '[]',
        tasks_pending         JSONB NOT NULL DEFAULT '[]',
        errors_encountered    JSONB NOT NULL DEFAULT '[]',
        started_at            TIMESTAMPTZ,
        ended_at              TIMESTAMPTZ NOT NULL,
        session_duration_m    INT,
        message_count         INT,
        total_tokens_used     INT,
        summary_embedding     vector(768) NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Indexes for common queries
    await pool.query(
      "CREATE INDEX IF NOT EXISTS idx_episodes_user_ended ON episodes (user_id, ended_at DESC)",
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS idx_episodes_channel ON episodes (channel_id, ended_at DESC)",
    );
  }

  async upsertEpisode(episode: EpisodeInsert): Promise<EpisodeRow> {
    const pool = await this.ensurePool();
    const result = await pool.query(
      `INSERT INTO episodes (
        source_session_id, source_session_key, user_id, agent_id, channel_id,
        summary, key_decisions, files_touched, tasks_completed, tasks_pending,
        errors_encountered, started_at, ended_at, session_duration_m,
        message_count, total_tokens_used, summary_embedding
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17
      )
      ON CONFLICT (source_session_id) DO UPDATE SET
        summary = EXCLUDED.summary,
        key_decisions = EXCLUDED.key_decisions,
        files_touched = EXCLUDED.files_touched,
        tasks_completed = EXCLUDED.tasks_completed,
        tasks_pending = EXCLUDED.tasks_pending,
        errors_encountered = EXCLUDED.errors_encountered,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        session_duration_m = EXCLUDED.session_duration_m,
        message_count = EXCLUDED.message_count,
        total_tokens_used = EXCLUDED.total_tokens_used,
        summary_embedding = EXCLUDED.summary_embedding
      RETURNING *`,
      [
        episode.sourceSessionId,
        episode.sourceSessionKey ?? null,
        episode.userId,
        episode.agentId,
        episode.channelId ?? null,
        episode.summary,
        JSON.stringify(episode.keyDecisions),
        JSON.stringify(episode.filesTouched),
        JSON.stringify(episode.tasksCompleted),
        JSON.stringify(episode.tasksPending),
        JSON.stringify(episode.errorsEncountered),
        episode.startedAt ?? null,
        episode.endedAt,
        episode.sessionDurationM ?? null,
        episode.messageCount ?? null,
        episode.totalTokensUsed ?? null,
        toPgVector(episode.summaryEmbedding),
      ],
    );
    return rowToEpisode(result.rows[0]);
  }

  /** Vector similarity search using cosine distance. */
  async searchEpisodes(params: {
    embedding: number[];
    userId: string;
    channelId?: string;
    maxResults: number;
    maxAgeDays: number;
    threshold: number;
  }): Promise<EpisodeSearchResult[]> {
    const pool = await this.ensurePool();
    const cutoff = new Date(Date.now() - params.maxAgeDays * 86_400_000);

    // Cosine distance: 1 - (a <=> b) gives similarity in [0, 1]
    const result = await pool.query(
      `SELECT *,
        1 - (summary_embedding <=> $1::vector) AS similarity
      FROM episodes
      WHERE user_id = $2
        AND ended_at >= $3
        AND 1 - (summary_embedding <=> $1::vector) >= $4
      ORDER BY similarity DESC
      LIMIT $5`,
      [
        toPgVector(params.embedding),
        params.userId,
        cutoff,
        params.threshold,
        params.maxResults,
      ],
    );

    return result.rows.map((row: Record<string, unknown>) => ({
      episode: rowToEpisode(row),
      similarity: row.similarity as number,
    }));
  }

  async getRecentEpisodes(userId: string, channelId?: string, limit = 5): Promise<EpisodeRow[]> {
    const pool = await this.ensurePool();
    if (channelId) {
      const result = await pool.query(
        `SELECT * FROM episodes
         WHERE user_id = $1 AND channel_id = $2
         ORDER BY ended_at DESC LIMIT $3`,
        [userId, channelId, limit],
      );
      return result.rows.map(rowToEpisode);
    }
    const result = await pool.query(
      `SELECT * FROM episodes WHERE user_id = $1 ORDER BY ended_at DESC LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map(rowToEpisode);
  }

  async getEpisodeById(episodeId: string): Promise<EpisodeRow | null> {
    const pool = await this.ensurePool();
    const result = await pool.query("SELECT * FROM episodes WHERE episode_id = $1", [episodeId]);
    return result.rows.length > 0 ? rowToEpisode(result.rows[0]) : null;
  }

  async deleteEpisode(episodeId: string): Promise<boolean> {
    const pool = await this.ensurePool();
    const result = await pool.query("DELETE FROM episodes WHERE episode_id = $1", [episodeId]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteAllUserEpisodes(userId: string): Promise<number> {
    const pool = await this.ensurePool();
    const result = await pool.query("DELETE FROM episodes WHERE user_id = $1", [userId]);
    return result.rowCount ?? 0;
  }

  async getEpisodeStats(userId: string): Promise<EpisodeStats> {
    const pool = await this.ensurePool();
    const result = await pool.query(
      `SELECT
        COUNT(*)::int AS total,
        MAX(ended_at) AS latest,
        MIN(ended_at) AS oldest
      FROM episodes WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0] as Record<string, unknown>;
    return {
      totalEpisodes: (row.total as number) ?? 0,
      latestEpisodeAt: row.latest ? new Date(row.latest as string) : null,
      oldestEpisodeAt: row.oldest ? new Date(row.oldest as string) : null,
    };
  }

  async cleanupOldEpisodes(maxAgeDays: number): Promise<number> {
    const pool = await this.ensurePool();
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
    const result = await pool.query("DELETE FROM episodes WHERE ended_at < $1", [cutoff]);
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
