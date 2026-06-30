// Organize driver (04-02): drive the existing segmentation + association producers over
// seeded history so spans/boxes/tags/entities become navigable (ROADMAP SC1 "searchable").
// Proves the historical store is populated and that a re-run is idempotent (no duplicate
// spans/boxes). Dreaming stays deferred (A2) — cursor `dreamed` remains false. DI: DB env
// is injected; the runtime is never booted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { listMemoryEntities, listMemoryTags } from "./associative-store.js";
import { readOrganizeCursor } from "./backfill-cursor.js";
import { runBackfillOrganize } from "./backfill-organize.js";
import { appendTurns, listBoxes, listSpans, type NewTurn } from "./turns-store.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-backfill-organize-"));
}

function env(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
}

function turn(seq: number, role: string, content: string): NewTurn {
  return { role, content, contentHash: `h${seq}`, idempotencyKey: `k${seq}`, ts: seq };
}

function seedHistory(stateDir: string): void {
  // Content carries salient tokens (→ topic spans/boxes/tags) and a code entity (NEBULA-73).
  appendTurns({
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    env: env(stateDir),
    turns: [
      turn(1, "user", "Deploy the NEBULA-73 telemetry service to the production cluster"),
      turn(2, "assistant", "The NEBULA-73 telemetry deployment finished on the production cluster"),
    ],
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("runBackfillOrganize", () => {
  it("makes seeded history navigable: spans/boxes/tags/entities exist", () => {
    const stateDir = tempStateDir();
    seedHistory(stateDir);

    const result = runBackfillOrganize({ agentId: AGENT_ID, env: env(stateDir) });
    expect(result.sessionKey).toBe(SESSION_KEY);
    expect(result.segmented).toBe(true);

    const dbOpts = { agentId: AGENT_ID, sessionKey: SESSION_KEY, env: env(stateDir) };
    expect(listSpans(dbOpts).length).toBeGreaterThan(0);
    expect(listBoxes(dbOpts).length).toBeGreaterThan(0);
    expect(listMemoryTags({ agentId: AGENT_ID, env: env(stateDir) }).length).toBeGreaterThan(0);
    expect(listMemoryEntities({ agentId: AGENT_ID, env: env(stateDir) }).length).toBeGreaterThan(0);

    expect(
      readOrganizeCursor({ agentId: AGENT_ID, sessionKey: SESSION_KEY, env: env(stateDir) }),
    ).toEqual({ segmented: true });
  });

  it("is idempotent: re-running organize adds no duplicate spans/boxes", () => {
    const stateDir = tempStateDir();
    seedHistory(stateDir);
    const dbOpts = { agentId: AGENT_ID, sessionKey: SESSION_KEY, env: env(stateDir) };

    runBackfillOrganize({ agentId: AGENT_ID, env: env(stateDir) });
    const spans = listSpans(dbOpts).length;
    const boxes = listBoxes(dbOpts).length;

    runBackfillOrganize({ agentId: AGENT_ID, env: env(stateDir) });
    expect(listSpans(dbOpts).length).toBe(spans);
    expect(listBoxes(dbOpts).length).toBe(boxes);
  });
});
