/** Write an offline, synthetic Usage workload using the existing SQLite owners. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

export const USAGE_AGENTS = {
  main: "Main",
  research: "Research",
  reviewer: "Review",
  ops: "Operations",
};
export const USAGE_AGENT = "research";
const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type UsageTruth = {
  startDate: string;
  endDate: string;
  families: number;
  instances: number;
  retained: number;
  archived: number;
  tokens: number;
  cents: number;
  activeFamilies: number;
  dayTokens: Record<string, number>;
  selectedRows: Record<string, { tokens: number; cents: number; label: string }>;
};

export async function seedUsageTeam(
  root: string,
  count: number,
  endDate: string,
  project: boolean,
) {
  const end = Date.parse(endDate);
  assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert(Number.isSafeInteger(count) && count >= 4 && count < 16_000 && Number.isFinite(end));
  const start = end - 29 * DAY;
  const stateDir = path.join(root, "state");
  await mkdir(root, { mode: 0o700 });
  await mkdir(path.join(root, "workspace"));
  await mkdir(stateDir);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const env = { ...process.env };
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(
        Object.entries(USAGE_AGENTS).map(([agentId, name]) => [
          agentId,
          { name, workspace: path.join(root, "workspace") },
        ]),
      ),
    },
  };
  const [
    { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync },
    { writeSessionEntry },
    { appendTranscriptEventsInTransaction },
    { refreshCostUsageCacheForAgent },
    { closeOpenClawStateDatabaseAsync },
  ] = await Promise.all([
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
    import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
    import("../../src/infra/session-cost-usage-aggregation.js"),
    import("../../src/state/openclaw-state-db.js"),
  ]);
  const agents = Object.keys(USAGE_AGENTS);
  const truth: UsageTruth = {
    startDate: isoDay(start),
    endDate,
    families: count,
    instances: 0,
    retained: 0,
    archived: 0,
    tokens: 0,
    cents: 0,
    activeFamilies: 0,
    dayTokens: {},
    selectedRows: {},
  };
  // Record the billable event facts for an oracle independent of Gateway projections, report folds and UI formatting.
  const bills: Array<{
    agentId: string;
    key: string;
    label: string;
    day: string;
    tokens: number;
    cents: number;
  }> = [];
  try {
    for (const [agentIndex, agentId] of agents.entries()) {
      const options = { agentId, env };
      for (let first = agentIndex; first < count; first += 40 * agents.length) {
        runOpenClawAgentWriteTransaction((database) => {
          for (let i = first; i < Math.min(count, first + 40 * agents.length); i += agents.length) {
            const sessionKey = `agent:${agentId}:dashboard:usage-proof-${i}`;
            const label = `${USAGE_AGENTS[agentId as keyof typeof USAGE_AGENTS]} ${["investigation", "implementation", "review", "planning"][Math.floor(i / 4) % 4]} #${i}`;
            const retained = i % 7 === 0;
            const archived = i % 5 === 0;
            truth.archived += Number(archived);
            for (let generation = Number(retained); generation >= 0; generation--) {
              const sessionId = `usage-proof-${i}-${generation}`;
              const dayBack =
                ((Math.floor(i / agents.length) * 31 + agentIndex * 11) % 180) + generation * 13;
              const updatedAt = end - dayBack * DAY + (18 + (i % 5)) * 3_600_000;
              const turns = i % 59 === 0 ? 48 : 2 + (i % 6);
              writeSessionEntry(database, sessionKey, {
                label,
                sessionId,
                createdAt: updatedAt - 2 * DAY,
                updatedAt,
                visibility: "shared",
                status: "done",
                ...(archived ? { archivedAt: updatedAt } : {}),
                ...(retained && generation === 0
                  ? {
                      usageFamilyKey: sessionKey,
                      usageFamilySessionIds: ["usage-proof-" + i + "-1", sessionId],
                    }
                  : {}),
                ...(i % 4 !== 1 ? { createdActor: { type: "agent", id: agentId } } : {}),
              });
              const events: TranscriptEvent[] = [
                {
                  type: "session",
                  version: 3,
                  id: sessionId,
                  timestamp: new Date(updatedAt - 2 * DAY).toISOString(),
                },
              ];
              let parentId: string | null = null;
              for (let turn = 0; turn < turns; turn++) {
                const timestamp =
                  updatedAt - (turns - 1 - turn) * 59_000 - (turn % 3 === 0 ? 2 * DAY : 0);
                const input = 800 + ((i * 43 + turn * 1357) % 7_500);
                const output = 120 + ((i * 3 + turn * 89) % 2_600);
                const cacheRead = (i + turn) % 3 === 0 ? 1_280 : 0;
                const cacheWrite = (i + turn) % 11 === 0 ? 640 : 0;
                const tokens = input + output + cacheRead + cacheWrite;
                const cents = 1 + ((i * 3 + turn * 7) % 27);
                for (const role of ["user", "assistant"] as const) {
                  const id = `${sessionId}-${turn}-${role}`;
                  events.push({
                    type: "message",
                    id,
                    parentId,
                    timestamp: new Date(timestamp).toISOString(),
                    message: {
                      role,
                      timestamp,
                      content: [
                        {
                          type: "text",
                          text:
                            role === "user"
                              ? "Check the test runs and summarize the results."
                              : "Reviewed the synthetic test logs and recorded the passing checks.",
                        },
                      ],
                      ...(role === "assistant"
                        ? {
                            provider: "synthetic",
                            model: ["fixture-small", "fixture-medium", "fixture-large"][turn % 3],
                            usage: {
                              input,
                              output,
                              cacheRead,
                              cacheWrite,
                              totalTokens: tokens,
                              cost: { total: cents / 100 },
                            },
                          }
                        : {}),
                    },
                  });
                  parentId = id;
                }
                bills.push({
                  agentId,
                  key: sessionKey,
                  label,
                  day: isoDay(timestamp),
                  tokens,
                  cents,
                });
              }
              appendTranscriptEventsInTransaction(
                database,
                { ...options, sessionKey, sessionId },
                events,
              );
              truth.instances++;
              truth.retained += generation;
            }
          }
        }, options);
        await yieldTurn();
      }
    }
    for (const bill of bills.filter(
      (row) =>
        row.agentId === USAGE_AGENT && row.day >= truth.startDate && row.day <= truth.endDate,
    )) {
      truth.tokens += bill.tokens;
      truth.cents += bill.cents;
      truth.dayTokens[bill.day] = (truth.dayTokens[bill.day] ?? 0) + bill.tokens;
      const row = (truth.selectedRows[bill.key] ??= { tokens: 0, cents: 0, label: bill.label });
      row.tokens += bill.tokens;
      row.cents += bill.cents;
    }
    truth.activeFamilies = Object.keys(truth.selectedRows).length;
    await closeOpenClawAgentDatabasesAsync(stateDir);
    if (project) {
      for (const agentId of agents) {
        let more = false;
        do {
          more = false;
          const refreshed = await refreshCostUsageCacheForAgent({
            config,
            agentId,
            env,
            storePath: path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
            onRemaining: () => {
              more = true;
            },
            waitForRefresh: true,
          });
          assert.equal(refreshed, "refreshed");
        } while (more);
        console.info(`projected ${agentId}`);
      }
    }
    await writeFile(path.join(root, "truth.json"), JSON.stringify(truth, null, 2));
    await writeFile(
      path.join(root, "bills.jsonl"),
      bills.map((bill) => JSON.stringify(bill)).join("\n") + "\n",
    );
    return truth;
  } finally {
    await closeOpenClawAgentDatabasesAsync(stateDir);
    await closeOpenClawStateDatabaseAsync();
  }
}
