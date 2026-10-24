import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import {
  initSubagentRegistry,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import {
  makeRestartRecoveryRun as makeRunRecord,
  type useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

export async function restartRegistry(
  fixture: ReturnType<typeof useSubagentRestartRecoveryFixture>,
  beforeInit?: () => void | Promise<void>,
) {
  await resetSubagentRegistryForTests({ persist: false });
  if (beforeInit) {
    await beforeInit();
  }
  rotateAgentEventLifecycleGeneration();
  await initSubagentRegistry();
  await fixture.activateGatewayRuntime();
  await fixture.settle();
}

export function readSession(sessionKey: string, agentId = "main") {
  return loadExactSessionEntry({ agentId, sessionKey })?.entry;
}

export async function rawChildFixture(phase: "recovery" | "restore") {
  const childSessionKey = "global";
  const runId = `raw-owner-${phase}`;
  const startedAt = Date.now() - 1_000;
  const endedAt = startedAt + 500;
  const restored = phase === "restore";
  for (const agentId of ["main", "research"]) {
    await replaceSessionEntry(
      { agentId, sessionKey: childSessionKey },
      {
        sessionId: `${agentId}-${phase}-session`,
        lifecycleRevision: `${agentId}-${phase}-revision`,
        lifecycleRunId: agentId === "research" ? runId : "unrelated-main-run",
        ...(restored ? { status: agentId === "research" ? "done" : "interrupted", endedAt } : {}),
        abortedLastRun: !restored || agentId === "main",
        startedAt,
        updatedAt: restored ? endedAt : startedAt,
      },
    );
  }
  return {
    runId,
    childSessionKey,
    startedAt,
    endedAt,
    mainBefore: readSession(childSessionKey),
    run: (overrides: Parameters<typeof makeRunRecord>[0] = {}) =>
      makeRunRecord({
        runId,
        childSessionKey,
        childAgentId: "research",
        childSessionIdentity: {
          sessionId: `research-${phase}-session`,
          lifecycleRevision: `research-${phase}-revision`,
        },
        ...overrides,
      }),
  };
}

export function createRecoverySessions(
  fixture: ReturnType<typeof useSubagentRestartRecoveryFixture>,
) {
  const writeSession = (
    params: Omit<Parameters<typeof writeSubagentSessionEntry>[0], "stateDir" | "agentId">,
  ) => writeSubagentSessionEntry({ stateDir: fixture.stateDir, agentId: "main", ...params });
  function childFixture(name: string, revision: string | null = `${name}-revision`) {
    const lifecycleRevision = revision ?? undefined;
    const runId = `run-${name}`;
    const childSessionKey = `agent:main:subagent:${name}`;
    const sessionId = `sess-${name}`;
    return {
      runId,
      childSessionKey,
      sessionId,
      run: (overrides: Parameters<typeof makeRunRecord>[0] = {}) =>
        makeRunRecord({
          runId,
          childSessionKey,
          childSessionIdentity: { sessionId, lifecycleRevision },
          ...overrides,
        }),
      write: (
        overrides: Omit<Parameters<typeof writeSession>[0], "sessionKey" | "defaultSessionId"> = {},
      ) =>
        writeSession({
          sessionKey: childSessionKey,
          defaultSessionId: sessionId,
          lifecycleRevision,
          ...overrides,
        }),
      read: () => readSession(childSessionKey),
    };
  }
  return { writeSession, childFixture };
}
