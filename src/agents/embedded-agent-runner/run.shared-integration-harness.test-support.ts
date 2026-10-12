import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  createOverflowRunParams,
  warmRunOverflowCompactionHarness,
  type TestRunEmbeddedAgent,
} from "./run.overflow-compaction.harness.js";
import { guardRunWorkspaceOwnership } from "./run.workspace-ownership.test-support.js";

let sharedRunEmbeddedAgent: Promise<TestRunEmbeddedAgent> | undefined;
let sharedSessionState: Promise<OpenClawTestState> | undefined;
let sessionSequence = 0;

/**
 * These scenarios intentionally cross several runner owners. Load the mocked
 * public entrypoint once so independent assertions do not repeatedly rebuild
 * the same production module graph.
 */
export function loadSharedRunIntegrationHarness(): Promise<TestRunEmbeddedAgent> {
  sharedRunEmbeddedAgent ??= (async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    await withOpenClawTestState({ label: "shared-run-warmup" }, async (state) => {
      const guard = await guardRunWorkspaceOwnership(state);
      try {
        await warmRunOverflowCompactionHarness(runEmbeddedAgent, state);
      } finally {
        guard.verifyAndRestore();
      }
    });
    return runEmbeddedAgent;
  })();
  return sharedRunEmbeddedAgent;
}

/** Close only after every case has drained its work and released its selectors. */
export async function cleanupSharedRunIntegrationSessions(): Promise<void> {
  await (await sharedSessionState)?.cleanup();
}

/** Reuse real databases; each case owns distinct session rows and workspace files. */
export async function createSharedRunIntegrationSession() {
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  const { captureEnv } = await import("../../test-utils/env.js");
  const { resetConfigRuntimeState } = await import("../../config/runtime-snapshot.js");
  const { drainSessionStateForTest } = await import("../../test-utils/session-state-cleanup.js");
  const { loadSessionEntry, replaceSessionEntry } =
    await import("../../config/sessions/session-accessor.js");
  const { forgetActiveSessionForShutdown } =
    await import("../../gateway/active-sessions-shutdown-tracker.js");
  sharedSessionState ??= createOpenClawTestState({
    label: "run-integration-sessions",
    applyEnv: false,
  });
  const state = await sharedSessionState;
  const env = captureEnv(Object.keys(state.envVars));
  state.applyEnv();
  const caseId = ++sessionSequence;
  const sessionId = `test-session-${caseId}`;
  const sessionKey = `agent:main:test-key-${caseId}`;
  const workspaceDir = path.join(state.workspaceDir, `case-${caseId}`);
  const baseRunParams = createOverflowRunParams({ workspaceDir });
  const sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      forgetActiveSessionForShutdown(sessionId);
      const current = loadSessionEntry({ ...sessionTarget, readConsistency: "latest" });
      if (current) {
        forgetActiveSessionForShutdown(current.sessionId);
      }
      env.restore();
      resetConfigRuntimeState();
    })());
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    // The public lane owner still installs the real durable writer claim.
    await replaceSessionEntry(sessionTarget, { sessionId, updatedAt: 1 });
    return {
      runParams: {
        ...baseRunParams,
        sessionId,
        sessionKey,
        runId: `run-integration-${caseId}`,
        sessionTarget,
      },
      makeAttemptResult: (overrides?: Parameters<typeof makeAttemptResult>[0]) =>
        makeAttemptResult({ sessionIdUsed: sessionId, ...overrides }),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
