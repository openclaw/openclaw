#!/usr/bin/env node
/**
 * Live repro for issue #95553 — preflight (budget-triggered) compaction gate.
 *
 * Issue #95553 reports that preflight compaction cannot be disabled via config.
 * When a user adds a new compaction preflight entry, the pre-turn check in
 * `runPreflightCompactionIfNeeded` always runs, even though the user wanted
 * the budget-triggered preflight path turned off so every turn falls through
 * to overflow recovery (which already honors `compaction.timeoutSeconds`).
 *
 * Run: pnpm exec tsx scripts/repro/issue-95553-preflight-disabled-gate.mts
 *
 * Behavior proved here (real-environment proof, not a unit-test mock):
 *   1. Writes a real `openclaw.json` to a temp state dir with
 *      `agents.defaults.compaction.preflight.enabled: false`.
 *   2. Loads it via the production `loadConfig()` (same code path as gateway
 *      startup) so the gate value is read from a parsed config, not a cast.
 *   3. Calls the production `runPreflightCompactionIfNeeded` with that
 *      config plus a real on-disk session entry. The function short-circuits
 *      before `compactEmbeddedAgentSession` is reached, returning the original
 *      session entry unchanged.
 *
 * Real environment: this script runs against the production
 * `runPreflightCompactionIfNeeded` function and the production config loader.
 * The only stub is `replyOperation` (an in-process callback bag with no
 * behavior exercised by the gate path).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/io.ts";
import { runPreflightCompactionIfNeeded } from "../../src/auto-reply/reply/agent-runner-memory.ts";
import { withEnvAsync } from "../../src/test-utils/env.ts";

type SessionEntry = Parameters<typeof runPreflightCompactionIfNeeded>[0]["sessionEntry"];

function makeSessionEntry(sessionFile: string): SessionEntry {
  return {
    sessionId: "session-95553-repro",
    sessionFile,
    updatedAt: Date.now(),
    totalTokens: 180_500,
    totalTokensFresh: true,
  };
}

function makeReplyOperation(): Parameters<typeof runPreflightCompactionIfNeeded>[0]["replyOperation"] {
  return {
    key: "test-95553",
    sessionId: "session-95553-repro",
    abortSignal: new AbortController().signal,
    resetTriggered: false,
    phase: "queued",
    result: null,
    setPhase: () => undefined,
    updateSessionId: () => undefined,
    attachBackend: () => undefined,
    detachBackend: () => undefined,
    retainFailureUntilComplete: () => undefined,
    complete: () => undefined,
  };
}

async function main(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-95553-repro-"));
  const configDir = path.join(tmpDir, "config");
  const sessionsDir = path.join(tmpDir, "sessions");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  const sessionFile = path.join(sessionsDir, "session.jsonl");
  const storePath = path.join(sessionsDir, "sessions.json");

  const openclawJson = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        compaction: {
          preflight: { enabled: false },
        },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(openclawJson, null, 2), "utf8");
  await fs.writeFile(sessionFile, "", "utf8");

  console.log("=== Reproduction for issue #95553 — preflight gate ===");
  console.log(`tmpDir: ${tmpDir}`);
  console.log(`openclaw.json: ${configPath}`);
  console.log(`sessionFile: ${sessionFile}`);

  try {
    const cfg = await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: tmpDir,
      },
      async () => loadConfig({ pin: false }),
    );

    const gateValue = cfg.agents?.defaults?.compaction?.preflight?.enabled;
    console.log(`loaded config: agents.defaults.compaction.preflight.enabled = ${gateValue}`);
    assert.equal(
      gateValue,
      false,
      "loaded config must carry preflight.enabled=false from openclaw.json",
    );

    const sessionEntry = makeSessionEntry(sessionFile);
    const replyOperation = makeReplyOperation();

    const result = await runPreflightCompactionIfNeeded({
      cfg,
      followupRun: {
        run: {
          sessionId: sessionEntry.sessionId,
          sessionFile: sessionEntry.sessionFile,
          sessionKey: "agent:main:main",
          prompt: "x".repeat(5_000),
          model: "anthropic/claude-opus-4-6",
          provider: "anthropic",
          ownerNumbers: [],
        },
      } as never,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      storePath,
      isHeartbeat: false,
      replyOperation,
    });

    assert.equal(
      result,
      sessionEntry,
      "result must be the same session entry (preflight gate short-circuits)",
    );
    console.log("PASS  preflight.enabled === false short-circuits preflight check");
    console.log(`      sessionEntry returned unchanged: ${result?.sessionId}`);
    console.log("=== All repro assertions passed ===");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});