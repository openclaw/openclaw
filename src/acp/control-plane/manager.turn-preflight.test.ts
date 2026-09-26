/** ACP preflight failures settle their task without erasing successor liveness. */
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { getTaskById } from "../../tasks/task-registry-query.js";
import { isAcpTurnActive } from "./active-turns.js";
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
} from "./manager.test-helpers.js";

describe("AcpSessionManager", () => {
  installAcpSessionManagerTestLifecycle();

  it.each(["metadata failure", "signal failure", "abort", "actor replacement"] as const)(
    "settles only the created task when preflight ends with %s",
    async (reason) => {
      await withAcpManagerTaskStateDir(async () => {
        const sessionKey = "agent:codex:acp:preflight-child";
        const requestId = "preflight-run";
        const runtime = createRuntime();
        hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
          id: "acpx",
          runtime: runtime.runtime,
        });
        mockParentedAcpSessionEntries({
          childSessionKey: sessionKey,
          parentSessionKey: "agent:main:main",
        });
        const manager = new AcpSessionManager();
        const reached = createDeferred();
        const release = createDeferred();
        const failure = new Error(`ACP preflight ${reason}`);
        const read = manager.resolveSessionAsync.bind(manager);
        const readSpy = vi.spyOn(manager, "resolveSessionAsync");
        if (reason !== "signal failure") {
          readSpy.mockImplementationOnce(async (params) => {
            reached.resolve();
            await release.promise;
            if (reason === "metadata failure") {
              throw failure;
            }
            return await read(params);
          });
        }
        const signalSpy =
          reason === "signal failure"
            ? vi
                .spyOn(sessionStateEvents, "recordSessionHumanDirectMessage")
                .mockImplementationOnce(async () => {
                  reached.resolve();
                  await release.promise;
                  throw failure;
                })
            : undefined;
        const controller = new AbortController();
        const input = {
          provenance: "system" as const,
          cfg: baseCfg,
          sessionKey,
          text: "Prepare the child turn",
          mode: "prompt" as const,
          requestId,
        };
        const pending = manager.runTurn({ ...input, signal: controller.signal });
        const outcome = pending.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const successorStarted = createDeferred();
        const releaseSuccessor = createDeferred();
        let successor: Promise<void> | undefined;
        try {
          expect(
            await Promise.race([
              reached.promise.then(() => "preflight"),
              outcome.then(() => "settled"),
            ]),
          ).toBe("preflight");
          const task = requireTaskByRunId(requestId);
          expect(task.status).toBe("running");
          expect(isAcpTurnActive({ sessionKey, agentId: "codex" })).toBe(true);
          expect(runtime.ensureSession).not.toHaveBeenCalled();
          expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
          let successorTaskId: string | undefined;
          if (reason === "abort") {
            controller.abort();
          } else if (reason === "actor replacement") {
            await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
              cfg: baseCfg,
              sessionKey,
              reason: "session-reset",
            });
            runtime.runTurn.mockImplementationOnce(async function* () {
              successorStarted.resolve();
              await releaseSuccessor.promise;
              yield { type: "done" as const };
            });
            successor = manager.runTurn(input);
            void successor.catch(() => {});
            await Promise.race([
              successorStarted.promise,
              successor.then(() => {
                throw new Error("Successor settled before starting its stream");
              }),
            ]);
            successorTaskId = requireTaskByRunId(requestId).taskId;
            expect(successorTaskId).not.toBe(task.taskId);
          }
          const metadataWrites = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
          release.resolve();
          const settled = await outcome;
          expect(settled.ok).toBe(false);
          expect(getTaskById(task.taskId)?.status).toBe(
            reason === "abort" || reason === "actor replacement" ? "cancelled" : "failed",
          );
          expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(metadataWrites);
          expect(isAcpTurnActive({ sessionKey, agentId: "codex" })).toBe(Boolean(successor));
          if (successorTaskId) {
            expect(getTaskById(successorTaskId)?.status).toBe("running");
            releaseSuccessor.resolve();
            await successor;
            expect(getTaskById(successorTaskId)?.status).toBe("succeeded");
            expect(getTaskById(task.taskId)?.status).toBe("cancelled");
          }
        } finally {
          release.resolve();
          releaseSuccessor.resolve();
          await Promise.allSettled([pending, ...(successor ? [successor] : [])]);
          readSpy.mockRestore();
          signalSpy?.mockRestore();
        }
      });
    },
  );
});
