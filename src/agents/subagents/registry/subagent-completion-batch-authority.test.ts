import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import type { ParticipationCeiling } from "../../participation-ceiling.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const ceiling = {
  kind: "send",
  profileId: "participant",
  sessionKey: "agent:main:original",
  tools: ["read"],
  permission: "guarded",
  source: {
    agentId: "main",
    sessionId: "original",
    lifecycleRevision: null,
    creatorProfileId: "creator",
    root: "/synthetic/root",
  },
} satisfies ParticipationCeiling;

it.each([false, true])(
  "separates complete participant restrictions, including cancellation=%s",
  (cancelled) => {
    const source = {};
    const invocation = {};
    const effect = vi.fn();
    const retained = vi.fn();
    const install = (runId: string, restriction: typeof ceiling | undefined) => {
      const entry: SubagentRunRecord = {
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        requesterSessionKey: "agent:main:original",
        requesterDisplayKey: "original",
        task: "bounded helper",
        cleanup: "keep",
        createdAt: 1,
        requiresCompletionAuthority: restriction ? true : undefined,
        ...(cancelled ? { endedReason: SUBAGENT_ENDED_REASON_KILLED } : {}),
        execution: { status: "terminal", outcome: { status: cancelled ? "error" : "ok" } },
      };
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "participant",
        scopes: ["operator.write"],
        participationCeiling: restriction,
        source,
        invocation,
        assertCurrent() {},
      });
      const run = <T>(work: () => T): T => {
        retained(runId);
        return work();
      };
      const custody: SubagentCompletionCustody["authority"] = {
        operatorAuthority: authority,
        scopes: ["operator.write"],
        signal: new AbortController().signal,
        assertCurrent: authority.assertCurrent,
        release() {},
        run,
        runWithRequester: run,
      };
      subagentRuns.set(runId, entry);
      subagentRuns.bindCompletionAuthority(entry, custody);
      return entry;
    };
    try {
      const anchor = install("anchor", ceiling);
      const same = install("same", structuredClone(ceiling));
      const owner = install("owner", undefined);
      const narrower = install("narrower", { ...ceiling, tools: [] });
      const otherInvitation = install("other", {
        ...ceiling,
        source: { ...ceiling.source, sessionId: "different" },
      });
      expect(
        subagentRuns.selectCompletionAuthorityBatch(
          [anchor, same, owner, narrower, otherInvitation],
          anchor,
        ),
      ).toEqual([anchor, same]);
      subagentRuns.runWithCompletionBatchAuthority([anchor, same], effect);
      expect(effect).toHaveBeenCalledOnce();
      expect(retained).toHaveBeenCalledOnce();
      effect.mockClear();
      for (const other of [owner, narrower, otherInvitation]) {
        expect(() => subagentRuns.runWithCompletionBatchAuthority([anchor, other], effect)).toThrow(
          /stay current and separate/,
        );
      }
      subagentRuns.releaseCompletionAuthority(anchor);
      expect(() => subagentRuns.runWithCompletionAuthority(anchor, effect)).toThrow(
        /original-source custody/,
      );
      expect(() => subagentRuns.runWithCompletionBatchAuthority([anchor, same], effect)).toThrow(
        /original-source custody/,
      );
      expect(effect).not.toHaveBeenCalled();
    } finally {
      subagentRuns.clear();
    }
  },
);
