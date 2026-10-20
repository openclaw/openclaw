import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import * as terminalState from "../../sessions/subagent-terminal-state.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { stopAcpControllerTurns } from "./manager.controller-test-support.js";
import {
  baseCfg,
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  mockMutableSession,
  mockParentedAcpSessionEntries,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("ACP terminal state signals", () => {
  installAcpSessionManagerTestLifecycle();
  afterEach(() => clearRuntimeConfigSnapshot());

  function setupParentedTurn(suffix: string) {
    const childSessionKey = `agent:main:acp:${suffix}`;
    setRuntimeConfigSnapshot(baseCfg);
    const { run, ...fixture } = managerFixture(childSessionKey);
    const metadata = { currentMeta: readySessionMeta() };
    mockMutableSession(childSessionKey, metadata);
    mockParentedAcpSessionEntries({
      childSessionKey,
      parentSessionKey: "agent:main:main",
      state: metadata,
    });
    return {
      ...fixture,
      events: async () =>
        (await listSessionStateEventsSince(childSessionKey, "main", 0, 200)).events,
      run: (requestId: string, overrides: Partial<Parameters<typeof run>[0]> = {}) =>
        run({ text: "complete the task", requestId, ...overrides }),
    };
  }

  it("records parented ACP turns only for human provenance", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const { runtimeState, run, events } = setupParentedTurn("child-state");
      await run("human-state-turn", { provenance: "human" });
      await run("system-state-turn");
      runtimeState.runTurn.mockImplementationOnce(async function* () {
        yield { type: "done" as const, status: "cancelled" as const };
      });
      await run("cancelled-state-turn");

      expect(await events()).toMatchObject([
        { kind: "human_direct_message", runId: "human-state-turn" },
        { kind: "run_completed", runId: "human-state-turn" },
        { kind: "run_completed", runId: "system-state-turn" },
        {
          kind: "run_failed",
          runId: "cancelled-state-turn",
          summary: "child run cancelled",
          payload: { outcome: "cancelled" },
        },
      ]);
    });
  });

  it("leaves a same-id predecessor's terminal outcome to it when a queued duplicate is cancelled", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const { runtimeState, run, events } = setupParentedTurn("same-id-duplicate");
      const entered = createDeferred();
      const release = createDeferred();
      runtimeState.runTurn.mockImplementationOnce(async function* () {
        entered.resolve();
        await release.promise;
        yield { type: "done" as const, stopReason: "end_turn" };
      });
      const predecessor = run("same-id");
      const abortDuplicate = new AbortController();
      let duplicate: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, predecessor]);
        duplicate = run("same-id", { signal: abortDuplicate.signal });
        abortDuplicate.abort();
        await duplicate;
        expect(await events()).toEqual([]);
        release.resolve();
        await predecessor;
      } finally {
        release.resolve();
        await Promise.allSettled([predecessor, duplicate]);
      }
      expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      expect(await events()).toMatchObject([{ kind: "run_completed", runId: "same-id" }]);
    });
  });

  it("keeps Stop joined to a finishing ACP turn's physical terminal writer", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const { run, target, runtimeState, events } = setupParentedTurn("contended-terminal");
      await run("warm-terminal-worker");
      const databasePath = resolveOpenClawStateSqlitePath();
      let holder: ReturnType<typeof holdStateDatabaseWriteTransaction> | undefined;
      const entered = createDeferred();
      const record = terminalState.recordSubagentTerminalState;
      const observe = vi
        .spyOn(terminalState, "recordSubagentTerminalState")
        .mockImplementation(async (...args) => {
          holder = holdStateDatabaseWriteTransaction(databasePath, 2_000);
          await holder.ready;
          entered.resolve();
          return await record(...args);
        });
      let settled = false;
      let stopSettled = false;
      let pending: Promise<void> | undefined;
      let stopped: Promise<void> | undefined;
      try {
        pending = run("contended-terminal").finally(() => {
          settled = true;
        });
        await Promise.race([entered.promise, pending]);
        stopped = stopAcpControllerTurns(target).then(() => {
          stopSettled = true;
        });
        await nextTurn();
        expect({ settled, stopSettled }).toEqual({ settled: false, stopSettled: false });
        expect(runtimeState.cancel).not.toHaveBeenCalled();
        if (!holder) {
          throw new Error("Expected terminal state writer contention");
        }
        expect(
          Atomics.load(holder.released, 0),
          "Gateway events must run before the holder's independent fallback releases contention",
        ).toBe(0);
      } finally {
        observe.mockRestore();
        holder?.release();
        try {
          await holder?.joined;
        } finally {
          await Promise.all([pending, stopped]);
        }
      }
      expect((await events()).map(({ kind, runId }) => ({ kind, runId }))).toEqual([
        { kind: "run_completed", runId: "warm-terminal-worker" },
        { kind: "run_completed", runId: "contended-terminal" },
      ]);
    });
  });
});
