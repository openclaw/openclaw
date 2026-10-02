import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  expectRecordFields,
  mockCallArg as getMockCallArg,
  mockGatewayMethods,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";

export function registerYieldedParentCleanupCase({
  getRegistry,
  mocks,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "callGateway" | "runSubagentAnnounceFlow" | "runSubagentEnded"
  >;
}) {
  it("keeps a paused parent out of ordinary terminal cleanup when descendants settle", async () => {
    const mod = getRegistry();
    mocks.entries = {
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    };
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": { status: "ok", startedAt: Date.now() - 1, endedAt: Date.now() },
    });

    await mod.addSubagentRunForTests({
      runId: "run-yielded-parent",
      childSessionKey: "agent:main:subagent:parent",
      task: "yielded parent waiting on descendants",
      createdAt: Date.parse("2026-06-26T02:17:00Z"),
      startedAt: Date.parse("2026-06-26T02:18:00Z"),
      endedAt: Date.parse("2026-06-26T02:19:00Z"),
      pauseReason: "sessions_yield",
      wakeOnDescendantSettle: true,
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    const parent = mod.getSubagentRunByRunId("run-yielded-parent");
    const terminalCommitted = createDeferred();
    const stopObserving = subscribeSubagentRunChanges("projection", () => {
      if (
        mod.getSubagentRunByRunId("run-yielded-child-finished")?.execution.status === "terminal"
      ) {
        terminalCommitted.resolve();
      }
    });
    const join = observeRootWork();
    try {
      await mod.registerSubagentRun({
        runId: "run-yielded-child-finished",
        requesterSessionKey: "agent:main:subagent:parent",
        requesterDisplayKey: "parent",
        task: "descendant settles after yield",
      });
      await terminalCommitted.promise;
    } finally {
      await join();
      stopObserving();
    }
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "child finished announce"),
      { childRunId: "run-yielded-child-finished" },
      "child finished announce params",
    );
    expect(mod.getSubagentRunByRunId("run-yielded-parent")).toBe(parent);
    expect(parent).toMatchObject({ pauseReason: "sessions_yield", cleanupHandled: false });
    expect(parent?.cleanupCompletedAt).toBeUndefined();
    expect(mocks.runSubagentEnded).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-yielded-parent" }),
      expect.anything(),
    );
  });
}
