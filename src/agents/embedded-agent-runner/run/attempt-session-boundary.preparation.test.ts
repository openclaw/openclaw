import path from "node:path";
import { expect, it, vi } from "vitest";
import * as pendingInputs from "../../../config/sessions/session-accessor.pending-inputs.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { prepareForeignPendingUserTurns } from "./pre-persisted-user-turn.js";

it("freezes foreign input exclusion across reload and provider conversion", async () => {
  const target = {
    agentId: "main",
    sessionId: "foreign-input-freeze",
    sessionKey: "agent:main:foreign-input-freeze",
    storePath: path.resolve("foreign-input-freeze.sqlite"),
  };
  const entries = new Map<string, string>();
  const reads = vi.fn(() => new Map(entries));
  const prepared = vi
    .spyOn(pendingInputs, "prepareForeignLiveSessionPendingInputEntries")
    .mockResolvedValueOnce(reads);
  const foreign: PersistedUserTurnMessage = {
    role: "user",
    content: "accepted foreign input",
    timestamp: 1,
    idempotencyKey: "foreign:user",
  };
  const activeSession = { agent: { state: { messages: [foreign] } } };
  try {
    const reconcile = await prepareForeignPendingUserTurns({ getSessionTarget: () => target });
    entries.set("foreign-entry", "foreign:user");
    expect(reconcile?.(activeSession, undefined)?.ownsEntry("foreign-entry")).toBe(true);
    expect(activeSession.agent.state.messages).toEqual([]);
    entries.clear();
    activeSession.agent.state.messages = [foreign];
    const frozen = reconcile?.(activeSession, undefined);
    expect(activeSession.agent.state.messages).toEqual([]);
    expect(frozen?.ownsEntry("foreign-entry")).toBe(true);
    const calls = reads.mock.calls.length;
    expect(frozen?.omitInput([foreign])).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(calls);
  } finally {
    prepared.mockRestore();
  }
});
