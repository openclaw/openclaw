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

describe("logical requester settlement", () => {
  beforeEach(() => {
    assertCurrent.mockReset();
    registry.markYielded.mockReset().mockResolvedValue(1);
    registry.settle.mockReset().mockResolvedValue(true);
  });

  it.each([true, false])(
    "acknowledges only a committed explicit yield (settled: %s)",
    async (settled) => {
      registry.settle.mockResolvedValue(settled);
      const result = makeResult({ yielded: true });
      if (settled) {
        await settleRequesterRun(requester, result, assertCurrent);
        expect(result.requesterContinuationSettled).toBe(true);
      } else {
        await expect(settleRequesterRun(requester, result, assertCurrent)).rejects.toThrow(
          "could not transfer",
        );
        expect(result.requesterContinuationSettled).toBeUndefined();
      }
    },
  );

  it("leaves implicit continuation gated on outbox status delivery", async () => {
    const result = makeResult({ continuationPending: true });
    await settleRequesterRun(requester, result, assertCurrent);
    expect(registry.markYielded).toHaveBeenCalledOnce();
    expect(registry.settle).not.toHaveBeenCalled();
    expect(result.requesterContinuationSettled).toBeUndefined();
  });

  it("transfers producer-owned completion after a partial harness receipt", async () => {
    const admission = prepareSystemAgentRunAdmission({}, requester.runId, "main", "yield-test");
    try {
      await admission.admit("embedded");
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
        requesterSessionKey: requester.sessionKey,
        requesterAgentId: requester.agentId,
        requesterTurnRunId: requester.runId,
        requesterYielded: true,
        acceptedSessionSpawns,
        assertCurrent: expect.any(Function),
      });
      expect(result.requesterContinuationSettled).toBe(true);
    } finally {
      admission.close();
    }
  });

  it("surfaces failed persistence without acknowledging a successor", async () => {
    registry.settle.mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const result = makeResult({ yielded: true });
    await expect(settleRequesterRun(requester, result, assertCurrent)).rejects.toThrow(
      "storage unavailable",
    );
    expect(result.requesterContinuationSettled).toBeUndefined();
  });

  it("fences a revoked requester before handoff", async () => {
    assertCurrent.mockImplementation(() => {
      throw new Error("requester replaced");
    });
    const result = makeResult({ yielded: true });
    await expect(settleRequesterRun(requester, result, assertCurrent)).rejects.toThrow(
      "requester replaced",
    );
    expect(registry.markYielded).not.toHaveBeenCalled();
    expect(registry.settle).not.toHaveBeenCalled();
    expect(result.requesterContinuationSettled).toBeUndefined();
  });

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
        const params = {
          ...requester,
          preparedRunAdmission: admission,
          abortSignal: abort.signal,
        };
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
        await settleFailedRequesterRun(params, new Error("provider failed"));
        if (owner === "active") {
          expect(registry.settle).toHaveBeenCalledExactlyOnceWith({
            requesterSessionKey: requester.sessionKey,
            requesterAgentId: requester.agentId,
            requesterTurnRunId: requester.runId,
            requesterYielded: false,
            acceptedSessionSpawns,
            assertCurrent: expect.any(Function),
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

  it("returns both failures without retrying a failed registry commit", async () => {
    const admission = prepareSystemAgentRunAdmission({}, requester.runId, "main", "failure-test");
    try {
      await admission.admit("embedded");
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
    } finally {
      admission.close();
    }
  });

  it("revalidates admission after the final caller assertion", async () => {
    const admission = prepareSystemAgentRunAdmission({}, requester.runId, "main", "assertion-test");
    try {
      await admission.admit("embedded");
      await expect(
        settleRequesterRun(
          { ...requester, preparedRunAdmission: admission },
          makeResult({ yielded: true }),
          () => admission.close(),
        ),
      ).rejects.toThrow("settlement is closed");
      expect(registry.settle).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });
});
