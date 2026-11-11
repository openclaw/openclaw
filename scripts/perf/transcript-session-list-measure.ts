/** Counts-only CLI workload. Run with node --import ./scripts/tsx.mjs. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "64" },
    reads: { type: "string", default: "5" },
  },
});
const sessions = Number(values.sessions);
const reads = Number(values.reads);
assert(Number.isSafeInteger(sessions) && sessions > 0);
assert(Number.isSafeInteger(reads) && reads > 0);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-list-measure-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
const phase = (name: string) => {
  if (process.env.SQLMEASURE_OUT) {
    fs.writeFileSync(path.join(process.env.SQLMEASURE_OUT, "phase"), name);
  }
};

const { Command } = await import("commander");
const { registerTranscriptsCli } = await import("../../src/cli/program/register.transcripts.js");
const { TranscriptsStore } = await import("../../src/transcripts/store.js");
const { summarizeTranscripts } = await import("../../src/transcripts/summary.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
try {
  phase("fixture");
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  for (let index = 0; index < sessions; index++) {
    const session = {
      sessionId: `synthetic-${index % 4}`,
      source: { providerId: "manual-transcript" },
      startedAt: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString(),
    };
    await store.writeSession(session);
    if (index % 2 === 0) {
      await store.writeSummary(summarizeTranscripts({ session, utterances: [] }), session);
    }
  }
  const entries = await store.listSessionEntries();
  assert.equal(entries.length, sessions);
  assert.equal(entries.filter((entry) => entry.hasSummary).length, Math.ceil(sessions / 2));
  await closeOpenClawStateDatabaseAsync();

  const program = new Command();
  registerTranscriptsCli(program);
  for (let index = 0; index <= reads; index++) {
    phase(index === 0 ? "cold-list" : `warm-list-${index}`);
    await program.parseAsync(["node", "openclaw", "transcripts", "list", "--json"]);
  }
  phase("close");
} finally {
  await closeOpenClawStateDatabaseAsync();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
