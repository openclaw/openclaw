/**
 * The restore path's resume/handoff decision, exercised against the real
 * session reconciliation module.
 *
 * `resolveSubagentRunOrphanReason` returns a deferred reader for the ordinary
 * case — a run with a child session key and no retained obligation — so a
 * truthiness test on its result classifies every such run as orphaned. The
 * restorer has already read that child session entry, so these cases pin that
 * the predicate finishes the classification instead of trusting the reader's
 * mere existence.
 */
import { describe, expect, it } from "vitest";
import type { InternalSessionEntry } from "../../../config/sessions.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRestoredSubagentRunHeldByAnotherOwner } from "./subagent-restore-resume-ownership.js";

const STALE_MS = 3 * 60 * 60 * 1_000;

function restoredRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const startedAt = Date.now() - 1_000;
  return {
    ...createSubagentRunRecord({
      runId: "restored-resume-run",
      childSessionKey: "agent:main:subagent:restored-resume",
      requesterSessionKey: "agent:main:main",
      task: "work that outlived its gateway",
      createdAt: startedAt,
      startedAt,
      expectsCompletionMessage: true,
    }),
    ...overrides,
  } as SubagentRunRecord;
}

function childSession(overrides: Partial<InternalSessionEntry> = {}): InternalSessionEntry {
  const endedAt = Date.now() - 10;
  return {
    sessionId: "restored-resume-session",
    status: "done",
    startedAt: endedAt - 500,
    endedAt,
    updatedAt: endedAt,
    ...overrides,
  } as InternalSessionEntry;
}

describe("restored subagent resume ownership", () => {
  it("resumes a recent child whose session already finished", () => {
    // The deferred reader exists for this run, but its classification is null:
    // the session is present, identified and not stale. Nothing holds the row,
    // so restore must resume it rather than wait for a sweep to settle it.
    expect(isRestoredSubagentRunHeldByAnotherOwner(restoredRun(), childSession())).toBe(false);
  });

  it("resumes a recent child whose session is still running", () => {
    expect(
      isRestoredSubagentRunHeldByAnotherOwner(
        restoredRun(),
        childSession({ status: undefined, endedAt: undefined }),
      ),
    ).toBe(false);
  });

  it("hands a run with no child session entry to orphan recovery", () => {
    expect(isRestoredSubagentRunHeldByAnotherOwner(restoredRun(), undefined)).toBe(true);
  });

  it("hands a child session with no session id to orphan recovery", () => {
    expect(
      isRestoredSubagentRunHeldByAnotherOwner(restoredRun(), childSession({ sessionId: "  " })),
    ).toBe(true);
  });

  it("hands a stale unended run to orphan recovery", () => {
    const startedAt = Date.now() - STALE_MS;
    const entry = restoredRun({
      createdAt: startedAt,
      execution: { status: "running", startedAt },
    });
    expect(isRestoredSubagentRunHeldByAnotherOwner(entry, childSession())).toBe(true);
  });

  it("hands an aborted child session to orphan recovery", () => {
    expect(
      isRestoredSubagentRunHeldByAnotherOwner(
        restoredRun(),
        childSession({ abortedLastRun: true }),
      ),
    ).toBe(true);
  });

  it("resumes a run whose retained obligation already names its owner", () => {
    // A pause reason is one of the obligations that makes the orphan resolver
    // return null outright, so no session entry can change the answer.
    const entry = restoredRun({ pauseReason: "sessions_yield" });
    expect(isRestoredSubagentRunHeldByAnotherOwner(entry, childSession())).toBe(false);
    expect(isRestoredSubagentRunHeldByAnotherOwner(entry, undefined)).toBe(false);
  });

  it("resumes a queued or already-ended row without consulting the session", () => {
    const endedAt = Date.now() - 5;
    expect(
      isRestoredSubagentRunHeldByAnotherOwner(
        restoredRun({ execution: { status: "queued", startedAt: undefined } }),
        undefined,
      ),
    ).toBe(false);
    expect(
      isRestoredSubagentRunHeldByAnotherOwner(
        restoredRun({ execution: { status: "terminal", startedAt: endedAt - 100, endedAt } }),
        undefined,
      ),
    ).toBe(false);
  });
});
