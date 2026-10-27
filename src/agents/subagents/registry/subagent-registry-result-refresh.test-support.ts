import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setGatewayDedupeEntry } from "../../../gateway/agent-turn/agent-job.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  createSessionEntry,
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentResultRefreshCases(params: {
  getRegistry: () => SubagentRegistryHarness;
  getLifecycleHandler: () => (event: AgentEventPayload) => void;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "callGateway"
    | "captureSubagentCompletionReply"
    | "persistRegistryRows"
    | "loadSessionEntry"
    | "entries"
    | "runSubagentAnnounceFlow"
    | "lifecycleGeneration"
  >;
}) {
  const { getRegistry, getLifecycleHandler, mocks } = params;
  it("tracks missing-entry lifecycle result refresh through restart drain until capture and persistence settle", async () => {
    const mod = getRegistry();
    const childSessionKey = "agent:main:subagent:refresh-admission";
    const reply = "replacement final reply";
    const waitStarted = createDeferred();
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": () => {
        waitStarted.resolve();
        return { status: "pending" };
      },
    });
    await mod.registerSubagentRun({
      runId: "run-refresh-admission-old",
      childSessionKey,
      sessionEntry: { sessionId: "sess-refresh-admission" },
      task: "capture replacement completion",
      expectsCompletionMessage: true,
    });
    await waitStarted.promise;
    const entry = expectDefined(
      await mod.getSubagentRunByChildSessionKey(childSessionKey),
      "registered result owner",
    );
    await updateSubagentRunFixture(entry.runId, (current) => {
      current.execution = {
        ...current.execution,
        status: "terminal",
        endedAt: Date.now(),
        outcome: { status: "ok" },
      };
      current.completion = {
        required: true,
        terminalReply: { disposition: "visible", text: reply },
      };
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const captureStarted = createDeferred();
    const capture = createDeferred<string>();
    const persisted = createDeferred();
    mocks.captureSubagentCompletionReply.mockImplementationOnce(() => {
      captureStarted.resolve();
      return capture.promise;
    });
    mocks.persistRegistryRows.mockImplementationOnce(() => persisted.resolve());
    const lifecycleHandler = getLifecycleHandler();

    try {
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        markGatewayRestartDraining();
        lifecycleHandler({
          runId: "run-refresh-admission-new",
          seq: 1,
          stream: "lifecycle",
          ts: Date.now(),
          sessionKey: childSessionKey,
          data: { phase: "end" },
        });
      }, "replacement-run");

      expect(getActiveGatewayRootWorkCount()).toBe(1);
      await captureStarted.promise;
      expect(mod.getSubagentRunByRunId(entry.runId)?.completion?.resultText).toBeUndefined();

      capture.resolve(reply);
      await persisted.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(mod.getSubagentRunByRunId(entry.runId)?.completion?.resultText).toBe(reply);
    } finally {
      capture.resolve(reply);
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("retains a run after session read failure and completes it on a later sweep", async () => {
    const mod = getRegistry();
    const childSessionKey = "agent:main:subagent:child";
    const startedAt = Date.now() - 2_000;
    mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "pending" } });
    await mod.registerSubagentRun({
      runId: "run-sweep-error",
      cleanup: "delete",
    });
    const run = expectDefined(
      await mod.getSubagentRunByChildSessionKey(childSessionKey),
      "registered run",
    );
    await updateSubagentRunFixture(run.runId, (next) => {
      next.execution.startedAt = startedAt;
    });
    const execution = structuredClone(mod.getSubagentRunByRunId(run.runId)?.execution);
    mocks.loadSessionEntry.mockClear().mockImplementation(() => {
      throw new Error("simulated sweep failure");
    });

    await mod.testing.sweepOnceForTests();
    await mod.testing.runSweeperTickForTests();

    expect(mocks.loadSessionEntry).toHaveBeenCalled();
    expect((await mod.getSubagentRunByChildSessionKey(childSessionKey))?.execution).toEqual(
      execution,
    );
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    mocks.loadSessionEntry.mockReset();
    mocks.entries[childSessionKey] = createSessionEntry({
      lifecycleRevision: "revision-child",
      status: "done",
      startedAt,
      endedAt: Date.now(),
      updatedAt: Date.now(),
    });
    setGatewayDedupeEntry({
      dedupe: new Map(),
      key: `agent:${run.runId}`,
      entry: {
        ts: Date.now(),
        ok: true,
        payload: {
          status: "completed",
          startedAt,
          endedAt: Date.now(),
          terminalReply: {
            disposition: "visible",
            text: "Completed after the session read recovered.",
          },
        },
      },
      session: {
        sessionKey: childSessionKey,
        sessionId: mocks.entries[childSessionKey].sessionId,
        agentId: "main",
        lifecycleGeneration: mocks.lifecycleGeneration,
      },
    });
    vi.setSystemTime(Date.now() + 1_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() =>
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: "run-sweep-error",
          outcome: expect.objectContaining({ status: "ok" }),
        }),
      ),
    );
    expect(mocks.entries[childSessionKey]?.status).toBe("done");
  });
}

export async function updateSubagentRunFixture(
  runId: string,
  update: (entry: SubagentRunRecord) => void,
) {
  await mutateSubagentRuns([runId], (rows) => {
    const current = expectDefined(rows.get(runId), "registered fixture run");
    const next = structuredClone(current);
    update(next);
    return { value: undefined, postimages: new Map([[runId, next]]) };
  });
}
