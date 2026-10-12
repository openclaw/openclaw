import { beforeEach, expect } from "vitest";
import {
  markRequesterTurnYielded,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

export const requesterKey = "agent:main:main";
export const childKey = (id: string) => `agent:main:subagent:${id}`;

/** Registers the requester session per case and yields announcing child cohorts from it. */
export function useSubagentProgressCohort(fixture: { readonly stateDir: string }) {
  beforeEach(async () => {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: requesterKey,
      defaultSessionId: "requester-session",
    });
  });

  /** The requester turn spawns announcing children, then yields them to its settle wake. */
  return async function yieldCohort(requesterTurnRunId: string, ids: readonly string[]) {
    for (const id of ids) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childKey(id),
        defaultSessionId: `${id}-session`,
      });
    }
    for (const id of ids) {
      await registerSubagentRun({
        runId: id,
        childSessionKey: childKey(id),
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterDisplayKey: requesterKey,
        requesterTurnRunId,
        task: `Delegated ${id}`,
        cleanup: "keep",
        expectsCompletionMessage: true,
      });
    }
    const spawns = ids.map((id) => ({
      runId: id,
      childSessionKey: childKey(id),
      expectsCompletionMessage: true,
    }));
    expect(
      await markRequesterTurnYielded({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId,
      }),
    ).toBe(ids.length);
    expect(
      await settleRequesterAfterSessionSpawns({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId,
        requesterYielded: true,
        acceptedSessionSpawns: spawns,
      }),
    ).toBe(true);
    return spawns;
  };
}
