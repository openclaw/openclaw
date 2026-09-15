import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { getCommandLaneSnapshot } from "../../../process/command-queue.js";
import { drainGlobalSingletonLifecycleState } from "../../../shared/global-singleton.js";
import { createSessionMaintenanceOwner } from "../../session-maintenance/coordinator.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
});

describe("foreground cancellation before queue admission", () => {
  it.each(
    [false, true].flatMap((preemptible) =>
      ["error", "string"].map((reasonType) => ({ preemptible, reasonType })),
    ),
  )(
    "settles $reasonType Stop before held maintenance cleanup, preemptible=$preemptible",
    async ({ preemptible, reasonType }) => {
      const key = `foreground-maintenance-${preemptible}`;
      const started = createDeferred();
      const cleanup = createDeferred();
      const owner = createSessionMaintenanceOwner({ sessionKey: key, preemptible });
      let writerFinished = false;
      const work = owner.track(
        owner.run(async () => {
          started.resolve();
          await cleanup.promise;
          writerFinished = true;
        }),
      );
      await started.promise;
      const abort = new AbortController();
      const reason =
        reasonType === "error" ? new Error("foreground stopped") : "foreground stopped";
      let generation = getAgentEventLifecycleGeneration();
      let params: RunEmbeddedAgentParams & { sessionFile: string } = {
        abortSignal: abort.signal,
        lifecycleGeneration: generation,
        prompt: "hello",
        runId: key,
        sessionFile: key,
        sessionId: key,
        sessionKey: key,
        timeoutMs: 30_000,
        trigger: "user",
        workspaceDir: "/tmp",
      };
      const controller = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => generation,
        getParams: () => params,
        globalLane: `${key}-global`,
        initialQueuedLifecycleGeneration: generation,
        sessionLane: key,
        setLifecycleGeneration: (next) => {
          generation = next;
        },
        setParams: (next) => {
          params = next;
        },
      });
      let taskRan = false;
      let settled = false;
      const run = controller
        .enqueueSession(async () => {
          taskRan = true;
        })
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      abort.abort(reason);
      let beforeCleanup: { settled: boolean; writerFinished: boolean; taskRan: boolean };
      try {
        await nextTurn();
        beforeCleanup = { settled, writerFinished, taskRan };
        expect(getCommandLaneSnapshot(key).queuedCount).toBe(0);
        expect(beforeCleanup.writerFinished).toBe(false);
        expect(beforeCleanup.taskRan).toBe(false);
        expect(owner.signal.aborted).toBe(preemptible);
        expect(
          beforeCleanup.settled,
          "Stop must settle independently of an unrelated writer's held cleanup",
        ).toBe(true);
      } finally {
        cleanup.resolve();
        await work;
        await run;
      }
      if (reason instanceof Error) {
        expect(await run).toBe(reason);
      } else {
        expect(await run).toMatchObject({ name: "AbortError", cause: reason });
      }
      expect(writerFinished).toBe(true);
      expect(taskRan).toBe(false);
      // A later optional owner must remain usable after the canceled caller drains.
      const successorAbort = new AbortController();
      const successor = createSessionMaintenanceOwner({
        sessionKey: key,
        preemptible: true,
        abortSignal: successorAbort.signal,
      });
      let successorRan = false;
      const successorWork = successor.track(
        successor.run(async () => {
          successorRan = true;
        }),
      );
      try {
        await nextTurn();
        expect(successorRan).toBe(true);
      } finally {
        successorAbort.abort();
        await Promise.allSettled([successorWork]);
      }
    },
  );
});
