/** Offline synthetic routes for the real Gateway delivery-preview workload. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function createDeliveryRecoveryFixtures(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `delivery-recovery-${index}`,
    sessionKey: `agent:main:delivery-recovery-${index}`,
    to: `+1555000${String(index).padStart(4, "0")}`,
  }));
}

async function seed() {
  const { values } = parseArgs({
    options: { sessions: { type: "string", default: "20" } },
  });
  const count = Number(values.sessions);
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 200);
  assert.ok(
    process.env.OPENCLAW_CONFIG_PATH && process.env.OPENCLAW_STATE_DIR,
    "An explicit synthetic config and state directory are required",
  );
  const [agentDb, stateDb, { writeSessionEntry }, { normalizeSessionDeliveryState }] =
    await Promise.all([
      import("../../src/state/openclaw-agent-db.js"),
      import("../../src/state/openclaw-state-db.js"),
      import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
      import("../../src/utils/delivery-context.shared.js"),
    ]);
  try {
    const now = Date.now();
    mkdirSync(process.env.OPENCLAW_STATE_DIR, { recursive: true });
    agentDb.runOpenClawAgentWriteTransaction(
      (database) => {
        for (const { sessionId, sessionKey, to } of createDeliveryRecoveryFixtures(count)) {
          writeSessionEntry(database, sessionKey, {
            sessionId,
            updatedAt: now,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "imessage", to, accountId: "default" },
            }),
          });
        }
      },
      { agentId: "main" },
    );
    console.log(JSON.stringify({ sessions: count }));
  } finally {
    await Promise.all([
      agentDb.closeOpenClawAgentDatabasesAsync(),
      stateDb.closeOpenClawStateDatabaseAsync(),
    ]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seed();
}
