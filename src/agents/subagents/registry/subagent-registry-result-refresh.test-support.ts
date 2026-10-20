import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  mockGatewayMethods,
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
    "callGateway" | "captureSubagentCompletionReply" | "persistRegistryRows"
  >;
}) {
  const { getRegistry, getLifecycleHandler, mocks } = params;
  it("tracks missing-entry lifecycle result refresh through restart drain until capture and persistence settle", async () => {
    const mod = getRegistry();
    const childSessionKey = "agent:main:subagent:refresh-admission";
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
    expect(mocks.callGateway).toHaveBeenCalled();
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
        terminalReply: { disposition: "visible", text: "replacement final reply" },
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
    mocks.persistRegistryRows.mockClear();
    mocks.persistRegistryRows.mockImplementationOnce(() => persisted.resolve());
    const lifecycleHandler = getLifecycleHandler();

    try {
      const parent = expectDefined(
        tryBeginGatewayRootWorkAdmission("replacement-run"),
        "replacement root",
      );
      try {
        await parent.run(async () => {
          markGatewayRestartDraining();
          lifecycleHandler({
            runId: "run-refresh-admission-new",
            seq: 1,
            stream: "lifecycle",
            ts: Date.now(),
            sessionKey: childSessionKey,
            data: { phase: "end" },
          });
        });
      } finally {
        parent.release();
      }

      expect(getActiveGatewayRootWorkCount()).toBe(1);
      await captureStarted.promise;
      expect(mocks.captureSubagentCompletionReply).toHaveBeenCalledOnce();
      expect(mod.getSubagentRunByRunId(entry.runId)?.completion?.resultText).toBeUndefined();

      capture.resolve("replacement final reply");
      await persisted.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(mod.getSubagentRunByRunId(entry.runId)?.completion?.resultText).toBe(
        "replacement final reply",
      );
      expect(mocks.persistRegistryRows).toHaveBeenCalledOnce();
    } finally {
      capture.resolve("replacement final reply");
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    }
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
