// Synthetic SQLite actor fixture: 5,000 stored sessions, 140 populated with ~68 KiB
// skills prompts and 40 transcript messages. No Gateway or production state access.
// node --import ./scripts/tsx.mjs scripts/perf/session-actor-retention-seed.ts --state-dir <new-directory>
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({ options: { "state-dir": { type: "string" } } });
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
await mkdir(root, { recursive: false });
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
await mkdir(process.env.TMPDIR!, { recursive: true });
const owner = await import("../../src/state/openclaw-agent-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { replaceSqliteTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
try {
  owner.runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < 5000; index++) {
        const sessionKey = `agent:main:transcript-broadcast-measure-child-${index}`;
        const sessionId = `synthetic-${index}`;
        writeSessionEntry(database, sessionKey, {
          sessionId,
          updatedAt: 1,
          label: `Synthetic session ${index}`,
          ...(index < 140
            ? {
                skillsSnapshot: {
                  prompt: `Synthetic skills ${index}\n${"skill instructions\n".repeat(3600)}`,
                  skills: [],
                },
              }
            : {}),
        });
        if (index < 140) {
          const events = [
            {
              type: "session",
              id: sessionId,
              version: 3,
              timestamp: "2026-01-01T00:00:00Z",
              cwd: "/synthetic",
            },
            ...Array.from({ length: 40 }, (_, message) => ({
              type: "message",
              id: `event-${index}-${message}`,
              parentId: message ? `event-${index}-${message - 1}` : null,
              timestamp: "2026-01-01T00:00:01Z",
              message: {
                role: message % 2 ? "assistant" : "user",
                content: [{ type: "text", text: "Synthetic conversation. ".repeat(40) }],
              },
            })),
          ];
          replaceSqliteTranscriptEventsInTransaction(
            database,
            { agentId: "main", sessionKey, sessionId },
            events,
          );
        }
      }
    },
    { agentId: "main", env: process.env },
  );
  console.log("Seeded 5,000 synthetic sessions; 140 populated entries and transcripts");
} finally {
  await owner.closeOpenClawAgentDatabasesAsync();
  const state = await import("../../src/state/openclaw-state-db.js");
  await state.closeOpenClawStateDatabaseAsync();
  const lifecycle = await import("../../src/shared/global-singleton.js");
  await lifecycle.drainGlobalSingletonLifecycleState();
}
