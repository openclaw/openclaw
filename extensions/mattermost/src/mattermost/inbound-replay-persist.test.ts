// Mattermost tests cover inbound replay dedupe persistence across restart.
import { installIsolatedPluginStateDirForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMattermostInboundReplayGuard } from "./monitor.js";

// Persistent dedupe is SQLite-backed; give each test a fresh state dir so it is
// isolated from other suites sharing the worker.
let stateDir: ReturnType<typeof installIsolatedPluginStateDirForTests>;

beforeEach(() => {
  stateDir = installIsolatedPluginStateDirForTests();
});

afterEach(() => {
  stateDir.restore();
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
