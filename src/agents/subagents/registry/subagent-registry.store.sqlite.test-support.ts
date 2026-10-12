/**
 * Shared fixtures for the subagent registry SQLite store tests.
 *
 * Extracted from subagent-registry.store.sqlite.test.ts so that file stays
 * under its line cap while the private-handoff cases live in their own
 * sibling suite against the identical run fixture and state directory.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

export function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-one",
    childSessionKey: "agent:main:subagent:one",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "check sqlite persistence",
    cleanup: "keep",
    createdAt: 100,
    expectsCompletionMessage: true,
    execution: {
      status: "terminal",
      startedAt: 110,
      endedAt: 250,
      outcome: { status: "ok", startedAt: 110, endedAt: 250, elapsedMs: 140 },
    },
    completion: {
      required: true,
      resultText: "done",
      capturedAt: 260,
      terminalReply: { disposition: "visible", text: "done" },
    },
    delivery: {
      status: "pending",
      createdAt: 270,
      lastAttemptAt: 280,
      attemptCount: 2,
      lastError: "retry later",
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:one",
        childRunId: "run-one",
        task: "check sqlite persistence",
        startedAt: 110,
        endedAt: 250,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      },
    },
    ...overrides,
  };
}

/**
 * Points the state database at a per-test temp dir and tears it down after.
 * Returns an accessor so cases that build paths under it can read the current
 * directory without owning the lifecycle.
 */
export function useTemporaryOpenClawStateDir(): { readonly path: string } {
  let tempStateDir: string | null = null;
  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-sqlite-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempStateDir);
  });
  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });
  return {
    get path() {
      if (!tempStateDir) {
        throw new Error("Temporary OpenClaw state directory is not active");
      }
      return tempStateDir;
    },
  };
}
