import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeAcceptedSessionSpawnsForRun } from "../accepted-session-spawn.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { settleFailedRequesterRun, settleRequesterRun } from "../requester-run-settlement.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const registry = vi.hoisted(() => ({ markYielded: vi.fn(), settle: vi.fn() }));
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  markRequesterTurnYielded: registry.markYielded,
  settleRequesterAfterSessionSpawns: registry.settle,
}));

const assertCurrent = vi.fn();
const requester = { sessionKey: "agent:main:main", agentId: "main", runId: "parent" };
const acceptedSessionSpawns = [
  { runId: "child", childSessionKey: "agent:main:subagent:child", expectsCompletionMessage: true },
];

function makeResult(meta: Partial<EmbeddedAgentRunResult["meta"]>): EmbeddedAgentRunResult {
  return { acceptedSessionSpawns, meta: { durationMs: 1, ...meta } };
}
const settlement = {
  requesterSessionKey: requester.sessionKey,
  requesterAgentId: requester.agentId,
  requesterTurnRunId: requester.runId,
  acceptedSessionSpawns,
  assertCurrent: expect.any(Function),
};
async function withAdmission(
  run: (admission: ReturnType<typeof prepareSystemAgentRunAdmission>) => Promise<void>,
) {
  const admission = prepareSystemAgentRunAdmission({}, requester.runId, "main", "settlement-test");
  try {
    await admission.admit("embedded");
    await run(admission);
  } finally {
    admission.close();
  }
}

describe("logical requester settlement", () => {
  beforeEach(() => {
    assertCurrent.mockReset();
    registry.markYielded.mockReset().mockResolvedValue(1);
    registry.settle.mockReset().mockResolvedValue(true);
  });

  it.each([
    ["committed", undefined],
    ["refused", "could not transfer"],
    ["storage failure", "storage unavailable"],
    ["revoked", "requester replaced"],
  ] as const)("acknowledges only a committed explicit yield: %s", async (outcome, error) => {
    registry.settle.mockResolvedValue(outcome !== "refused");
    if (outcome === "storage failure" || outcome === "revoked") {
      (outcome === "revoked" ? assertCurrent : registry.settle).mockImplementation(() => {
        throw new Error(error);
      });
    }
    const result = makeResult({ yielded: true });
    if (error === undefined) {
      await settleRequesterRun(requester, result, assertCurrent);
      expect(result.requesterContinuationSettled).toBe(true);
    } else {
      await expect(settleRequesterRun(requester, result, assertCurrent)).rejects.toThrow(error);
      expect(result.requesterContinuationSettled).toBeUndefined();
    }
    if (outcome === "revoked") {
      expect(registry.markYielded).not.toHaveBeenCalled();
      expect(registry.settle).not.toHaveBeenCalled();
    }
  });

  it("leaves implicit continuation gated on outbox status delivery", async () => {
    const result = makeResult({ continuationPending: true });
    await settleRequesterRun(requester, result, assertCurrent);
    expect(registry.markYielded).toHaveBeenCalledOnce();
    expect(registry.settle).not.toHaveBeenCalled();
    expect(result.requesterContinuationSettled).toBeUndefined();
  });

  it("transfers producer-owned completion after a partial harness receipt", () =>
    withAdmission(async (admission) => {
      mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance, acceptedSessionSpawns);
      const result: EmbeddedAgentRunResult = {
        acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
        meta: { durationMs: 1, yielded: true },
      };

      await settleRequesterRun(
        { ...requester, preparedRunAdmission: admission },
        result,
        assertCurrent,
      );

      expect(registry.settle).toHaveBeenCalledExactlyOnceWith({
        ...settlement,
        requesterYielded: true,
      });
      expect(result.requesterContinuationSettled).toBe(true);
    }));

  it.each(["cancelled", "aborted"] as const)("does not transfer %s ownership", async (kind) => {
    const result = makeResult({ yielded: true, ...(kind === "aborted" ? { aborted: true } : {}) });
    await settleRequesterRun(
      {
        ...requester,
        ...(kind === "cancelled" ? { abortSignal: AbortSignal.abort() } : {}),
      },
      result,
      assertCurrent,
    );
    expect(registry.markYielded).not.toHaveBeenCalled();
    expect(registry.settle).not.toHaveBeenCalled();
  });

  it.each(["active", "closed", "replaced", "source-revoked", "cancelled"] as const)(
    "releases failed requester receipts only for the current operational owner (%s)",
    async (owner) => {
      let current = true;
      const admission = prepareSystemAgentRunAdmission(
        {},
        requester.runId,
        "main",
        "failure-test",
        () => {
          if (!current) {
            throw new Error("source revoked");
          }
        },
      );
      const replacement = prepareSystemAgentRunAdmission(
        {},
        requester.runId,
        "main",
        "replacement",
      );
      const abort = new AbortController();
      try {
        await admission.admit("embedded");
        mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance, acceptedSessionSpawns);
        if (owner === "closed") {
          admission.close();
        }
        if (owner === "replaced") {
          await replacement.admit("embedded");
        }
        if (owner === "source-revoked") {
          current = false;
        }
        if (owner === "cancelled") {
          abort.abort();
        }
        await settleFailedRequesterRun(
          { ...requester, preparedRunAdmission: admission, abortSignal: abort.signal },
          new Error("provider failed"),
        );
        if (owner === "active") {
          expect(registry.settle).toHaveBeenCalledExactlyOnceWith({
            ...settlement,
            requesterYielded: false,
          });
        } else {
          expect(registry.settle).not.toHaveBeenCalled();
        }
      } finally {
        admission.close();
        replacement.close();
      }
    },
  );

  it("returns both failures without retrying a failed registry commit", () =>
    withAdmission(async (admission) => {
      const params = { ...requester, preparedRunAdmission: admission };
      mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance, acceptedSessionSpawns);
      const failure = new Error("registry unavailable");
      registry.settle.mockImplementation(() => {
        throw failure;
      });
      const original = new Error("provider failed");
      const combined = await settleFailedRequesterRun(params, original);
      expect(combined).toBeInstanceOf(AggregateError);
      expect(combined).toMatchObject({ errors: [original, failure], cause: original });
      expect(registry.settle).toHaveBeenCalledOnce();
      expect(await settleFailedRequesterRun(params, combined)).toBe(combined);
      expect(registry.settle).toHaveBeenCalledOnce();
    }));

  it("revalidates admission after the final caller assertion", () =>
    withAdmission(async (admission) => {
      await expect(
        settleRequesterRun(
          { ...requester, preparedRunAdmission: admission },
          makeResult({ yielded: true }),
          () => admission.close(),
        ),
      ).rejects.toThrow("settlement is closed");
      expect(registry.settle).not.toHaveBeenCalled();
    }));
});
