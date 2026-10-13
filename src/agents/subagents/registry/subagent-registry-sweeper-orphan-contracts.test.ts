/**
 * The orphan sweep's contracts with its callers, exercised against the real
 * session reconciliation module. The sibling attribution suite mocks that
 * module, which is why a raw-key owner loss and an unresolved deferred
 * observation were both invisible to it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { loadGatewayBootSegmentsForAttribution } from "./subagent-orphan-attribution.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const agentRunContext = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/agent-run-registry.js")>()),
  getAgentRunContext: () => agentRunContext.current,
}));
// Restart recovery is offered the row first; "ignored" is its decline, which is
// what lets the orphan path under test run.
vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>()),
  recoverInterruptedSubagentRow: async () => ({ status: "ignored" as const }),
}));

function staleRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const startedAt = Date.now() - 3 * 60 * 60 * 1_000;
  return {
    ...createSubagentRunRecord({
      runId: "orphan-contract-run",
      childSessionKey: "agent:main:subagent:orphan-contract",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "work the gateway died under",
      cleanup: "keep",
      createdAt: startedAt,
      startedAt,
    }),
    ...overrides,
  } as SubagentRunRecord;
}

describe("orphan sweep caller contracts", () => {
  beforeEach(() => {
    agentRunContext.current = undefined;
    resetGatewayWorkAdmission();
  });

  it("reconciles a raw child session key through its recorded owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      // "global" encodes no agent id, so the recorded owner is the only thing
      // that can resolve its store. Dropping it aborts the whole sweep.
      const entry = staleRun({ childSessionKey: "global", childAgentId: "worker" });
      replaceSessionEntrySync(
        { agentId: "worker", sessionKey: "global", env: state.env },
        { sessionId: "worker-child", updatedAt: entry.createdAt },
      );
      const { completeSubagentRunWithRecovery, sweeper } = createSubagentSweeperHarness({}, entry);
      await loadGatewayBootSegmentsForAttribution(Date.now(), { forceRefresh: true });

      await expect(sweeper.sweepOnce()).resolves.toBeUndefined();

      expect(completeSubagentRunWithRecovery).toHaveBeenCalledOnce();
      const [completion] = completeSubagentRunWithRecovery.mock.calls[0] as unknown as [
        SubagentCompletionRequest,
      ];
      expect(completion.expectedEntry).toBe(entry);
      expect(completion.sendFarewell).toBe(true);
      expect(completion.outcome.error).toEqual(expect.any(String));
    });
  });

  it("resolves the deferred orphan observation instead of formatting the observation itself", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const entry = staleRun();
      const { completeSubagentRunWithRecovery, sweeper } = createSubagentSweeperHarness({}, entry);
      // No boot history, so nothing overwrites the classification wording.
      await loadGatewayBootSegmentsForAttribution(Date.now(), { forceRefresh: true });

      await sweeper.sweepOnce();

      expect(completeSubagentRunWithRecovery).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          expectedEntry: entry,
          outcome: { status: "error", error: "subagent run orphaned: missing-session-entry" },
        }),
        "sweeper-lost-context",
      );
    });
  });

  it("carries execution authority that refuses a run which comes back to life", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const entry = staleRun();
      const { completeSubagentRunWithRecovery, sweeper } = createSubagentSweeperHarness({}, entry);
      const fence: { admitted?: boolean; admittedAfterRace?: boolean; hostAfterRace?: boolean } =
        {};
      completeSubagentRunWithRecovery.mockImplementation((async (
        request: SubagentCompletionRequest,
      ) => {
        // The controller holds the terminal lock here; this is the window the
        // run can be dispatched again in.
        fence.admitted = await request.recoveryCurrent?.prepare();
        agentRunContext.current = { runId: entry.runId };
        fence.admittedAfterRace = await request.recoveryCurrent?.prepare();
        fence.hostAfterRace = request.recoveryCurrent?.isHostCurrent();
      }) as never);
      await loadGatewayBootSegmentsForAttribution(Date.now(), { forceRefresh: true });

      await sweeper.sweepOnce();

      expect(completeSubagentRunWithRecovery).toHaveBeenCalledOnce();
      expect(fence).toEqual({
        admitted: true,
        admittedAfterRace: false,
        hostAfterRace: false,
      });
    });
  });
});
