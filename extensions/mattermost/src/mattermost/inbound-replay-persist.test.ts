// Mattermost tests cover inbound replay dedupe persistence across restart.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMattermostInboundReplayGuard } from "./monitor.js";

// Persistent dedupe is SQLite-backed; give each test a fresh state dir so it is
// isolated from other suites sharing the worker.
const tempDirs: string[] = [];
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-mattermost-replay-state-"));
  tempDirs.push(dir);
  process.env.OPENCLAW_STATE_DIR = dir;
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterEach(() => {
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mattermost inbound replay guard persistence", () => {
  it("a committed key still dedupes on a fresh guard instance (survives restart)", async () => {
    const replayKey = "default:post-1";

    const guardA = createMattermostInboundReplayGuard();
    expect((await guardA.claim(replayKey)).kind).toBe("claimed");
    await guardA.commit(replayKey);

    // Fresh instance == restart: a redelivered post must be recognized as a
    // duplicate, not re-processed.
    const guardB = createMattermostInboundReplayGuard();
    expect((await guardB.claim(replayKey)).kind).toBe("duplicate");
  });
});
