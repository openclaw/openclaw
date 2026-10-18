import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mergeAcceptedSessionSpawnsForRun } from "../accepted-session-spawn.js";
import { prepareSystemAgentRunAdmission as prepareAdmission } from "../admitted-run-context.js";
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
function createAdmission(assertSourceCurrent?: () => void) {
  const admission = prepareAdmission({}, requester.runId, "main", "test", assertSourceCurrent);
  onTestFinished(() => admission.close());
  return admission;
}
async function admit(assertSourceCurrent?: () => void) {
  const admission = createAdmission(assertSourceCurrent);
  await admission.admit("embedded");
  mergeAcceptedSessionSpawnsForRun(admission.operationalRunInstance, acceptedSessionSpawns);
  return { ...requester, preparedRunAdmission: admission };
}

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
  ["implicit", undefined],
  ["cancelled", undefined],
  ["aborted", undefined],
] as const)("settles requester continuation only when permitted: %s", async (outcome, error) => {
  registry.settle.mockResolvedValue(outcome !== "refused");
  if (outcome === "storage failure" || outcome === "revoked") {
    (outcome === "revoked" ? assertCurrent : registry.settle).mockImplementation(() => {
      throw new Error(error);
    });
  }
  const result = makeResult(
    outcome === "implicit"
      ? { continuationPending: true }
      : { yielded: true, aborted: outcome === "aborted" },
  );
  const params = {
    ...requester,
    abortSignal: outcome === "cancelled" ? AbortSignal.abort() : undefined,
  };
  if (error === undefined) {
    await settleRequesterRun(params, result, assertCurrent);
  } else {
    await expect(settleRequesterRun(params, result, assertCurrent)).rejects.toThrow(error);
  }
  expect(result.requesterContinuationSettled).toBe(outcome === "committed" ? true : undefined);
  expect(registry.markYielded).toHaveBeenCalledTimes(outcome === "implicit" ? 1 : 0);
  expect(registry.settle).toHaveBeenCalledTimes(
    ["revoked", "implicit", "cancelled", "aborted"].includes(outcome) ? 0 : 1,
  );
});

it("transfers producer-owned completion after a partial harness receipt", async () => {
  const params = await admit();
  const result: EmbeddedAgentRunResult = {
    acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
    meta: { durationMs: 1, yielded: true },
  };

  await settleRequesterRun(params, result, assertCurrent);

  expect(registry.settle.mock.calls).toEqual([[{ ...settlement, requesterYielded: true }]]);
  expect(result.requesterContinuationSettled).toBe(true);
});

it.each(["active", "closed", "replaced", "source-revoked", "cancelled"] as const)(
  "releases failed requester receipts only for the current operational owner (%s)",
  async (owner) => {
    let current = true;
    const params = await admit(() => {
      if (!current) {
        throw new Error("source revoked");
      }
    });
    const admission = params.preparedRunAdmission;
    const replacement = createAdmission();
    const abort = new AbortController();
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
      { ...params, abortSignal: abort.signal },
      new Error("provider failed"),
    );
    if (owner === "active") {
      expect(registry.settle.mock.calls).toEqual([[{ ...settlement, requesterYielded: false }]]);
    } else {
      expect(registry.settle).not.toHaveBeenCalled();
    }
  },
);

it("returns both failures without retrying a failed registry commit", async () => {
  const params = await admit();
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
});

it("revalidates admission after the final caller assertion", async () => {
  const params = await admit();
  await expect(
    settleRequesterRun(params, makeResult({ yielded: true }), () =>
      params.preparedRunAdmission.close(),
    ),
  ).rejects.toThrow("settlement is closed");
  expect(registry.settle).not.toHaveBeenCalled();
});
