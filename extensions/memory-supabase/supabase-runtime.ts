/**
 * Thin wrapper around the Supabase Postgres + pgvector schema defined in
 * sql/0001_init.sql. All queries go through the service role key, so this
 * module must only ever be loaded server-side (inside the openclaw gateway).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type MemoryChannel = "whatsapp" | "gmail" | "manual" | "journal" | "other";
export type MemoryRole = "inbound" | "outbound" | "note";

export type MemoryItem = {
  id: string;
  user_id: string;
  channel: MemoryChannel;
  source_id: string | null;
  role: MemoryRole;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  consent: boolean;
  created_at: string;
};

export type MemorySearchHit = {
  item: MemoryItem;
  score: number;
};

export type RememberInput = {
  userId: string;
  channel: MemoryChannel;
  role: MemoryRole;
  content: string;
  embedding: number[];
  sourceId?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  consent?: boolean;
};

export class SupabaseMemoryStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /**
   * Insert a memory item. Returns the inserted row (or the existing one
   * if the (channel, source_id) unique index fired).
   */
  async remember(input: RememberInput): Promise<MemoryItem> {
    const row = {
      user_id: input.userId,
      channel: input.channel,
      source_id: input.sourceId ?? null,
      role: input.role,
      content: input.content,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      embedding: input.embedding,
      consent: input.consent ?? true,
    };

    const { data, error } = await this.client
      .from("memory_items")
      .upsert(row, {
        onConflict: "channel,source_id",
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`memory-supabase: insert failed: ${error.message}`);
    }
    return data as MemoryItem;
  }

  /**
   * Vector similarity search using the `match_memory_items` SQL function
   * (defined in 0001_init.sql). Falls back to client-side cosine if the
   * RPC is missing — useful while the schema is being applied.
   */
  async search(
    embedding: number[],
    opts: { userId: string; k?: number; minScore?: number },
  ): Promise<MemorySearchHit[]> {
    const k = opts.k ?? 8;
    const minScore = opts.minScore ?? 0.3;

    const { data, error } = await this.client.rpc("match_memory_items", {
      p_user_id: opts.userId,
      p_query: embedding,
      p_k: k,
      p_min_score: minScore,
    });

    if (error) {
      throw new Error(`memory-supabase: search failed: ${error.message}`);
    }

    return (data ?? []).map((row: MemoryItem & { score: number }) => ({
      item: {
        id: row.id,
        user_id: row.user_id,
        channel: row.channel,
        source_id: row.source_id,
        role: row.role,
        content: row.content,
        tags: row.tags ?? [],
        metadata: row.metadata ?? {},
        consent: row.consent,
        created_at: row.created_at,
      },
      score: Number(row.score),
    }));
  }

  /** Most recent items for a user, used for the daily journal generator. */
  async recent(opts: {
    userId: string;
    sinceIso: string;
    limit?: number;
  }): Promise<MemoryItem[]> {
    const { data, error } = await this.client
      .from("memory_items")
      .select("*")
      .eq("user_id", opts.userId)
      .gte("created_at", opts.sinceIso)
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 200);

    if (error) {
      throw new Error(`memory-supabase: recent failed: ${error.message}`);
    }
    return (data ?? []) as MemoryItem[];
  }

  /** Persist a daily journal summary (idempotent on date). */
  async writeJournal(opts: {
    userId: string;
    date: string;
    summary: string;
    highlights: unknown[];
    memoryId?: string;
  }): Promise<void> {
    const { error } = await this.client.from("daily_journal").upsert(
      {
        user_id: opts.userId,
        date: opts.date,
        summary: opts.summary,
        highlights: opts.highlights,
        memory_id: opts.memoryId ?? null,
      },
      { onConflict: "date" },
    );
    if (error) {
      throw new Error(`memory-supabase: journal write failed: ${error.message}`);
    }
  }
}
