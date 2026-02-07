import type { OpenClawPluginService } from "openclaw/plugin-sdk";
import type pg from "pg";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import { getPool, closePool } from "./db.js";
import { ensureSchema } from "./schema.js";

function extractCommonFields(evt: Record<string, unknown>) {
  return {
    eventType: evt.type as string,
    sessionKey: (evt.sessionKey as string) || null,
    sessionId: (evt.sessionId as string) || null,
    channel: (evt.channel as string) || null,
    provider: (evt.provider as string) || null,
    model: (evt.model as string) || null,
  };
}

function extractUsageFields(evt: Record<string, unknown>) {
  const usage = evt.usage as Record<string, number> | undefined;
  return {
    tokensInput: usage?.input ?? null,
    tokensOutput: usage?.output ?? null,
    tokensTotal: usage?.total ?? null,
    costUsd: (evt.costUsd as number) ?? null,
    durationMs: (evt.durationMs as number) ?? null,
  };
}

async function insertEvent(pool: pg.Pool, evt: Record<string, unknown>): Promise<void> {
  const common = extractCommonFields(evt);
  const usage =
    evt.type === "model.usage"
      ? extractUsageFields(evt)
      : {
          tokensInput: null,
          tokensOutput: null,
          tokensTotal: null,
          costUsd: null,
          durationMs: (evt.durationMs as number) ?? null,
        };

  await pool.query(
    `INSERT INTO audit_events (
      event_type, session_key, session_id, channel, provider, model,
      tokens_input, tokens_output, tokens_total, cost_usd, duration_ms, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      common.eventType,
      common.sessionKey,
      common.sessionId,
      common.channel,
      common.provider,
      common.model,
      usage.tokensInput,
      usage.tokensOutput,
      usage.tokensTotal,
      usage.costUsd,
      usage.durationMs,
      JSON.stringify(evt),
    ],
  );
}

export function createCompoundPostgresService(): OpenClawPluginService {
  let pgPool: pg.Pool | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    id: "compound-postgres",
    async start(ctx) {
      pgPool = await getPool(ctx.logger);
      if (!pgPool) return;

      await ensureSchema(pgPool, ctx.logger);
      ctx.logger.info("compound-postgres: audit logging enabled");

      const poolRef = pgPool;
      unsubscribe = onDiagnosticEvent((evt) => {
        // Fire and forget — don't await to avoid blocking
        insertEvent(poolRef, evt as unknown as Record<string, unknown>).catch((err) => {
          ctx.logger.warn(`compound-postgres: insert failed: ${err}`);
        });
      });
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      await closePool();
      pgPool = null;
    },
  };
}
