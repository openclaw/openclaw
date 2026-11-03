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
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockMutableSession,
  mockParentedAcpSessionEntries,
  readySessionMeta,
} from "./manager.test-helpers.js";

describe("ACP terminal state signals", () => {
  installAcpSessionManagerTestLifecycle();
  afterEach(() => clearRuntimeConfigSnapshot());

  function setupParentedTurn(childSessionKey: string) {
    setRuntimeConfigSnapshot(baseCfg);
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const metadata = { currentMeta: readySessionMeta() };
    mockMutableSession(childSessionKey, metadata);
    mockParentedAcpSessionEntries({
      childSessionKey,
      parentSessionKey: "agent:main:main",
      state: metadata,
    });
    return {
      runtimeState,
      manager: new AcpSessionManager(),
      input: {
        provenance: "system" as const,
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "complete the task",
        mode: "prompt" as const,
      },
    };
  }

  it("records parented ACP turns only for human provenance", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const childSessionKey = "agent:main:acp:child-state";
      const { runtimeState, manager, input } = setupParentedTurn(childSessionKey);

      await manager.runTurn({
        ...input,
        provenance: "human",
        text: "human turn",
        requestId: "human-state-turn",
      });
      await manager.runTurn({
        ...input,
        text: "system turn",
        requestId: "system-state-turn",
      });
      runtimeState.runTurn.mockImplementationOnce(async function* () {
        yield { type: "done" as const, status: "cancelled" as const };
      });
      await manager.runTurn({
        ...input,
        text: "cancelled turn",
        requestId: "cancelled-state-turn",
      });

      expect(
        (await listSessionStateEventsSince(childSessionKey, "main", 0, 200)).events,
      ).toMatchObject([
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
      const childSessionKey = "agent:main:acp:same-id-duplicate";
      const { runtimeState, manager, input } = setupParentedTurn(childSessionKey);
      const entered = createDeferred();
      const release = createDeferred();
      runtimeState.runTurn.mockImplementationOnce(async function* () {
        entered.resolve();
        await release.promise;
        yield { type: "done" as const, stopReason: "end_turn" };
      });
      const predecessor = manager.runTurn({ ...input, requestId: "same-id" });
      const abortDuplicate = new AbortController();
      let duplicate: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, predecessor]);
        duplicate = manager.runTurn({
          ...input,
          requestId: "same-id",
          signal: abortDuplicate.signal,
        });
        abortDuplicate.abort();
        await duplicate;
        expect((await listSessionStateEventsSince(childSessionKey, "main", 0, 200)).events).toEqual(
          [],
        );
        release.resolve();
        await predecessor;
      } finally {
        release.resolve();
        await Promise.allSettled([predecessor, duplicate]);
      }
      expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      expect(
        (await listSessionStateEventsSince(childSessionKey, "main", 0, 200)).events,
      ).toMatchObject([{ kind: "run_completed", runId: "same-id" }]);
    });
  });

  it("keeps Stop joined to a finishing ACP turn's physical terminal writer", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const childSessionKey = "agent:main:acp:contended-terminal";
      const { manager, input, runtimeState } = setupParentedTurn(childSessionKey);
      await manager.runTurn({ ...input, requestId: "warm-terminal-worker" });
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
        pending = manager.runTurn({ ...input, requestId: "contended-terminal" }).finally(() => {
          settled = true;
        });
        await Promise.race([entered.promise, pending]);
        stopped = stopAcpControllerTurns(input).then(() => {
          stopSettled = true;
        });
        await nextTurn();
        expect(settled).toBe(false);
        expect(stopSettled).toBe(false);
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
      expect(settled).toBe(true);
      expect(stopSettled).toBe(true);
      expect(
        (await listSessionStateEventsSince(childSessionKey, "main", 0, 200)).events.map(
          (event) => ({
            kind: event.kind,
            runId: event.runId,
          }),
        ),
      ).toEqual([
        { kind: "run_completed", runId: "warm-terminal-worker" },
        { kind: "run_completed", runId: "contended-terminal" },
      ]);
    });
  });
});
