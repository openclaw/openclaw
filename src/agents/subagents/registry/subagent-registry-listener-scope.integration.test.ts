// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentRegistryFixture } from "./subagent-registry-live.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import {
  emitAgentEventIfCurrent,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  claimSubagentYield,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

const fixture = useSubagentRegistryFixture();
const stored = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);
afterEach(() => resetGatewayWorkAdmission());

async function useRealListener() {
  await resetSubagentRegistryForTests({ persist: false });
  const events = await vi.importActual<typeof import("../../../infra/agent-events.js")>(
    "../../../infra/agent-events.js",
  );
  vi.mocked(onAgentEvent).mockImplementation(events.onAgentEvent);
  await fixture.activateGatewayRuntime();
}

async function registerChild(runId: string, requesterSessionKey: string) {
  const childSessionKey = `agent:main:subagent:${runId}`;
  const sessionId = `${runId}-session`;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: childSessionKey },
    {
      sessionId,
      lifecycleRevision: "original",
      updatedAt: Date.now(),
      lifecycleRunId: runId,
      activeWriterRunId: runId,
    },
  );
  await registerSubagentRun({
    runId,
    childSessionKey,
    childAgentId: "main",
    sessionEntry: { sessionId, lifecycleRevision: "original" },
    requesterSessionKey,
    requesterAgentId: "main",
    requesterDisplayKey: "requester",
    task: "scope-close probe",
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  await fixture.settle();
  return { childSessionKey, sessionId };
}

it("persists a terminal lifecycle event after its emitter scope closes", async () => {
  await useRealListener();
  const runId = "listener-terminal-scope";
  const { childSessionKey } = await registerChild(runId, "agent:main:main");
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension).not.toBeNull();
  const emitter = new AsyncWorkScope();
  expect(
    emitter.run(() =>
      emitAgentEventIfCurrent({
        runId,
        sessionKey: childSessionKey,
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      }),
    ),
  ).toBe(true);
  emitter.beginClose();
  expect(suspension?.rollback()).toBe(true);
  await emitter.drain();
  await fixture.settle();
  expect(stored(runId)?.execution.status).toBe("terminal");
});

it.each(["lifecycle", "run owner"] as const)(
  "rejects a queued terminal event after its %s changes",
  async (changed) => {
    await useRealListener();
    const runId = `listener-replaced-${changed.replaceAll(" ", "-")}`;
    const { childSessionKey } = await registerChild(runId, "agent:main:main");
    const original = subagentRuns.get(runId)!;
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    const emitter = new AsyncWorkScope();
    expect(
      emitter.run(() =>
        emitAgentEventIfCurrent({
          runId,
          sessionKey: childSessionKey,
          stream: "lifecycle",
          data: { phase: "end", endedAt: Date.now() },
        }),
      ),
    ).toBe(true);
    emitter.beginClose();
    try {
      if (changed === "lifecycle") {
        rotateAgentEventLifecycleGeneration();
      } else {
        await mutateSubagentRuns([runId], (rows) => {
          const current = rows.get(runId)!;
          return {
            value: undefined,
            postimages: new Map([
              [
                runId,
                {
                  ...current,
                  createdAt: current.createdAt + 1,
                  generation: (current.generation ?? 0) + 1,
                },
              ],
            ]),
          };
        });
      }
    } finally {
      suspension?.rollback();
    }
    await emitter.drain();
    await fixture.settle();
    expect(stored(runId)?.execution.status).toBe("running");
    if (changed === "run owner") {
      expect(stored(runId)?.generation).toBe((original.generation ?? 0) + 1);
    }
  },
);

it("drains the terminal emitter before suspended admission reopens", async () => {
  await useRealListener();
  const runId = "listener-terminal-drain";
  const { childSessionKey } = await registerChild(runId, "agent:main:main");
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension).not.toBeNull();
  const emitter = new AsyncWorkScope();
  emitter.run(() =>
    emitAgentEventIfCurrent({
      runId,
      sessionKey: childSessionKey,
      stream: "lifecycle",
      data: { phase: "end", endedAt: Date.now() },
    }),
  );
  emitter.beginClose();
  const drain = emitter.drain();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drainedBeforeOpen: boolean;
  try {
    drainedBeforeOpen = await Promise.race([
      drain.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    suspension?.rollback();
  }
  await drain;
  await fixture.settle();
  expect(drainedBeforeOpen).toBe(true);
  expect(stored(runId)?.execution.status).toBe("terminal");
});

it("settles an unreachable yielded child after the requester event scope closes", async () => {
  await useRealListener();
  const runId = "listener-requester-scope";
  const requesterSessionKey = "agent:main:missing-requester";
  const { childSessionKey } = await registerChild(runId, requesterSessionKey);
  await claimSubagentYield({
    runId,
    sessionKey: childSessionKey,
    agentId: "main",
    waitForMessage: true,
    hasPendingWork: () => false,
  });
  await mutateSubagentRuns([runId], (rows) => {
    const entry = { ...rows.get(runId)! };
    markSubagentRunPausedAfterYield({ entry, endedAt: Date.now() });
    return { value: undefined, postimages: new Map([[runId, entry]]) };
  });
  expect(subagentRuns.get(runId)?.pauseReason).toBe("sessions_yield");
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension).not.toBeNull();
  const emitter = new AsyncWorkScope();
  emitter.run(() => sessionChanges.emit({ sessionKey: requesterSessionKey, scope: "runtime" }));
  emitter.beginClose();
  expect(suspension?.rollback()).toBe(true);
  await emitter.drain();
  await fixture.settle();
  expect(stored(runId)?.pauseReason).toBeUndefined();
  expect(stored(runId)?.execution.outcome).toMatchObject({
    status: "error",
    error: expect.stringMatching(/requester/i),
  });
});
