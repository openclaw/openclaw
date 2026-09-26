import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import * as terminalState from "../../sessions/subagent-terminal-state.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
} from "./manager.test-helpers.js";

describe("ACP terminal state signals", () => {
  installAcpSessionManagerTestLifecycle();

  it("records parented ACP turns only for human provenance", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const childSessionKey = "agent:main:acp:child-state";
      mockParentedAcpSessionEntries({
        childSessionKey,
        parentSessionKey: "agent:main:main",
      });
      const manager = new AcpSessionManager();

      await manager.runTurn({
        provenance: "human",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "human turn",
        mode: "prompt",
        requestId: "human-state-turn",
      });
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "system turn",
        mode: "prompt",
        requestId: "system-state-turn",
      });
      runtimeState.runTurn.mockImplementationOnce(async function* () {
        yield { type: "done" as const, status: "cancelled" as const };
      });
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "cancelled turn",
        mode: "prompt",
        requestId: "cancelled-state-turn",
      });

      expect(listSessionStateEventsSince(childSessionKey, "main", 0, 200).events).toMatchObject([
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

  it("keeps ACP completion joined without blocking the event loop on terminal signal contention", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const childSessionKey = "agent:main:acp:contended-terminal";
      mockParentedAcpSessionEntries({
        childSessionKey,
        parentSessionKey: "agent:main:main",
      });
      const manager = new AcpSessionManager();
      const input = {
        provenance: "system" as const,
        cfg: baseCfg,
        sessionKey: childSessionKey,
        text: "complete the task",
        mode: "prompt" as const,
      };
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
      let pending: Promise<void> | undefined;
      try {
        pending = manager.runTurn({ ...input, requestId: "contended-terminal" }).finally(() => {
          settled = true;
        });
        await Promise.race([entered.promise, pending]);
        await nextTurn();
        expect(settled).toBe(false);
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
          await pending;
        }
      }
      expect(settled).toBe(true);
      expect(requireTaskByRunId("contended-terminal").status).toBe("succeeded");
      expect(
        listSessionStateEventsSince(childSessionKey, "main", 0, 200).events.map((event) => ({
          kind: event.kind,
          runId: event.runId,
        })),
      ).toEqual([
        { kind: "run_completed", runId: "warm-terminal-worker" },
        { kind: "run_completed", runId: "contended-terminal" },
      ]);
    });
  });
});
