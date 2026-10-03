import { describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";
import {
  acceptRequesterAuthorityWave,
  captureRequesterAuthorityAdmissionAssertion,
  type RequesterAuthorityDispatch,
  type RequesterAuthorityWaveReceipt,
  retireRequesterAuthorityCohort,
  settleRequesterAuthorityWave,
} from "./requester-cron-authority-cohort.js";

const SESSION = "agent:main:requester-receipt";

function createBatch(requesterTurnRunId: string, count = 1): SubagentRunRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const runId = `${requesterTurnRunId}-child-${index}`;
    const entry: SubagentRunRecord = {
      runId,
      requesterTurnRunId,
      requesterAgentId: "main",
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: SESSION,
      requesterDisplayKey: "control-ui",
      task: "audit",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "terminal", endedAt: 2 },
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: "delivered" },
    };
    return entry;
  });
}

describe("requester authority retirement receipts", () => {
  it("retains an unsettled admitted-wave receipt after all scoped turns end", async () => {
    const batch = createBatch("unsettled-wave-member");
    const cohort = {
      batch,
      runs: new Map(batch.map((entry) => [entry.runId, entry])),
      scopedTurns: 0,
      operatorAuthority: {},
      admittedWaves: new Map([["accepted-wave", { batch }]]),
    };
    const discard = vi.fn();
    const bindings = new WeakMap<object, unknown>();
    retireRequesterAuthorityCohort(cohort, bindings, () => true, discard);
    expect(discard).not.toHaveBeenCalled();
    expect(cohort).toHaveProperty("retired", true);
    settleRequesterAuthorityWave(cohort, batch);
    retireRequesterAuthorityCohort(cohort, bindings, () => true, discard);
    expect(discard).toHaveBeenCalledOnce();
  });

  it("revokes a retired cohort immediately even with unsettled admitted receipts", () => {
    const batch = createBatch("revoked-unsettled-wave");
    const cohort = {
      batch,
      runs: new Map(batch.map((entry) => [entry.runId, entry])),
      retired: true as const,
      scopedTurns: 1,
      operatorAuthority: {},
      admittedWaves: new Map([["accepted-wave", { batch }]]),
    };
    const discard = vi.fn();
    retireRequesterAuthorityCohort(cohort, new WeakMap(), () => false, discard);
    expect(discard).toHaveBeenCalledOnce();
  });
  it("records only acceptance and releases a non-Cron turn without losing its receipt", () => {
    const batch = createBatch("non-cron");
    const member = batch[0];
    if (!member) {
      throw new Error("non-Cron fixture requires a wave member");
    }
    const authority = {
      kind: "yield" as const,
      batch,
      runs: new Map(batch.map((entry) => [entry.runId, entry])),
      requesterSessionKey: SESSION,
      requesterSessionId: "parent-id",
      operatorAuthority: {},
      scopedTurns: 0,
      retired: undefined as true | undefined,
      admittedWaves: new Map<string, RequesterAuthorityWaveReceipt>(),
    };
    const dispatch: RequesterAuthorityDispatch<typeof authority> = {
      authority,
      runId: "accepted-wave",
      consumed: false,
      isCurrent: () => true,
      wave: { batch },
    };
    const target = {
      runId: dispatch.runId,
      sessionKey: SESSION,
      sessionId: "parent-id",
      inputProvenance: {
        kind: "inter_session" as const,
        sourceTool: "subagent_settle",
        sourceSessionKey: member.childSessionKey,
      },
    };
    const bindings = new WeakMap<object, unknown>();
    const discard = vi.fn();
    const retire = () => retireRequesterAuthorityCohort(authority, bindings, () => true, discard);
    const assertCurrent = captureRequesterAuthorityAdmissionAssertion(dispatch, target);
    assertCurrent();
    // Failed preaccept work must leave the exact wave retryable, without a reservation.
    expect(authority.admittedWaves.size).toBe(0);
    expect(dispatch.consumed).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      acceptRequesterAuthorityWave(dispatch, target, aborted.signal, bindings, retire),
    ).toThrow();
    expect(authority.admittedWaves.size).toBe(0);
    expect(dispatch.consumed).toBe(false);
    const release = acceptRequesterAuthorityWave(
      dispatch,
      target,
      new AbortController().signal,
      bindings,
      retire,
    );
    expect(dispatch.consumed).toBe(true);
    expect(authority.scopedTurns).toBe(1);
    expect(dispatch.wave?.scope?.active).toBe(true);
    expect(authority.admittedWaves.has(dispatch.runId)).toBe(true);
    release?.();
    release?.();
    expect(dispatch.wave?.scope?.active).toBe(false);
    expect(authority.scopedTurns).toBe(0);
    expect(discard).not.toHaveBeenCalled();
    settleRequesterAuthorityWave(authority, batch);
    retire();
    expect(discard).toHaveBeenCalledOnce();
  });
});
