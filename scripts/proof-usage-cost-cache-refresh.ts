/**
 * Real-runtime proof for usage-cost cache refresh batching.
 *
 * Drives the production `refreshCostUsageCache` and `loadCostUsageSummaryFromCache`
 * code paths against an on-disk OPENCLAW_STATE_DIR. It creates a synthetic session
 * corpus, performs a cold refresh, appends to every transcript so the cache entries
 * are stale, and refreshes again. The assertions pin that the aggregate cache remains
 * fresh and correct after many stale files are processed in one refresh.
 *
 * Run with: pnpm tsx scripts/proof-usage-cost-cache-refresh.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  loadCostUsageSummaryFromCache,
  refreshCostUsageCache,
} from "../src/infra/session-cost-usage.js";

const sessionCount = Number.parseInt(process.env.OPENCLAW_USAGE_COST_PROOF_SESSIONS ?? "400", 10);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-cost-proof-"));
const previousStateDir = process.env.OPENCLAW_STATE_DIR;
process.env.OPENCLAW_STATE_DIR = root;

try {
  const sessionsDir = path.join(root, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const firstTimestamp = "2026-02-05T12:00:00.000Z";
  const secondTimestamp = "2026-02-05T12:01:00.000Z";
  const makeEntry = (sessionId: string, timestamp: string, totalTokens: number) =>
    JSON.stringify({
      type: "message",
      timestamp,
      sessionId,
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.5",
        usage: {
          input: totalTokens,
          output: 0,
          totalTokens,
          cost: { total: totalTokens / 1000 },
        },
      },
    });

  for (let index = 0; index < sessionCount; index += 1) {
    const sessionId = `usage-cost-proof-${index}`;
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", version: 1, id: sessionId })}\n${makeEntry(sessionId, firstTimestamp, 1)}\n`,
      "utf-8",
    );
  }

  const coldStart = performance.now();
  await refreshCostUsageCache();
  const coldMs = performance.now() - coldStart;

  for (let index = 0; index < sessionCount; index += 1) {
    const sessionId = `usage-cost-proof-${index}`;
    await fs.appendFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${makeEntry(sessionId, secondTimestamp, 2)}\n`,
      "utf-8",
    );
  }

  const refreshStart = performance.now();
  await refreshCostUsageCache();
  const staleRefreshMs = performance.now() - refreshStart;

  const summary = await loadCostUsageSummaryFromCache({
    startMs: Date.UTC(2026, 1, 5),
    endMs: Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1,
    requestRefresh: false,
  });

  const expectedTokens = sessionCount * 3;
  if (summary.totals.totalTokens !== expectedTokens) {
    throw new Error(`expected ${expectedTokens} tokens, got ${summary.totals.totalTokens}`);
  }
  if (summary.cacheStatus?.status !== "fresh") {
    throw new Error(`expected fresh cache, got ${summary.cacheStatus?.status ?? "missing"}`);
  }

  const cachePath = path.join(sessionsDir, ".usage-cost-cache.json");
  const cacheStats = await fs.stat(cachePath);
  console.log(
    JSON.stringify(
      {
        sessionCount,
        coldMs: Math.round(coldMs),
        staleRefreshMs: Math.round(staleRefreshMs),
        cacheBytes: cacheStats.size,
        totalTokens: summary.totals.totalTokens,
        cacheStatus: summary.cacheStatus?.status,
      },
      null,
      2,
    ),
  );
  console.log("All runtime assertions passed.");
} finally {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  await fs.rm(root, { recursive: true, force: true });
}
