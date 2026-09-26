import * as commandTaskRuntime from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createAgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("native background command outcomes", () => {
  it.each([
    "complete",
    "cancel",
    "natural success",
    "natural failure",
    "natural failure during stop",
    "source retired during stop",
    "publication failure",
    "refused stop",
    "failed stop",
    "concurrent stop",
    "authority retired during inventory",
    "changed handle",
    "source retired",
    "client closed",
  ] as const)(
    "keeps a retained native command owned after its foreground turn ends (%s)",
    async (scenario) => {
      const finished = createDeferred<void>();
      const terminateStarted = createDeferred<void>();
      const terminateRelease = createDeferred<void>();
      const releaseSource = vi.fn();
      const releaseTask = vi.fn();
      let cancellationCurrent = true;
      let finishAttempts = 0;
      let terminationAttempts = 0;
      let stopAttempts: Promise<PromiseSettledResult<void>[]> | undefined;
      let cancelOwner: (() => Promise<void>) | undefined;
      let commandTaskId: string | undefined;
      const createTask = commandTaskRuntime.createAgentHarnessCommandTask;
      const admission = vi
        .spyOn(commandTaskRuntime, "createAgentHarnessCommandTask")
        .mockImplementation(async (input) => {
          cancelOwner = () =>
            input.cancel("Cancelled by operator.", () => {
              if (!cancellationCurrent) {
                throw new Error("Task cancellation authority retired");
              }
            });
          const task = await createTask(input);
          commandTaskId = task.task.taskId;
          return {
            ...task,
            release() {
              releaseTask();
              task.release();
            },
            async finish(terminal) {
              try {
                finishAttempts += 1;
                if (scenario === "client closed" || scenario === "publication failure") {
                  throw new Error("Synthetic terminal publication failure");
                }
                return await task.finish(terminal);
              } finally {
                finished.resolve();
              }
            },
          };
        });
      const params = createTestParams();
      const host = await createAdmittedHostCapabilityTestFixture(params);
      params.agentHarnessTaskRuntimeScope = host.agentHarnessTaskRuntimeScope;
      const source = new AbortController();
      params.hostCapabilities = {
        ...params.hostCapabilities,
        retainSourceAuthority: () => ({
          modelPolicyRequired: false,
          assertCurrent: () => source.signal.throwIfAborted(),
          signal: source.signal,
          release: releaseSource,
          bindModelExecution: () => ({
            signal: source.signal,
            assertCurrent: () => source.signal.throwIfAborted(),
            release() {},
          }),
        }),
      };
      const command = {
        type: "commandExecution",
        id: "visible-command",
        command: "python3 synthetic-worker.py",
        cwd: "/workspace",
        processId: "54527",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };
      let retained = false;
      const terminal = (exitCode: number) =>
        itemNotification("item/completed", {
          ...command,
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
          aggregatedOutput: "synthetic outcome",
          durationMs: 1,
        });
      const harness = createStartedThreadHarness(async (method, input) => {
        if (method === "thread/backgroundTerminals/list") {
          if (retained && scenario === "authority retired during inventory") {
            cancellationCurrent = false;
          }
          return {
            data: [
              {
                itemId:
                  retained && scenario === "changed handle" ? "successor-command" : command.id,
                processId: "54527",
                command: command.command,
                cwd: "/workspace",
              },
            ],
            nextCursor: null,
          };
        }
        if (method === "thread/backgroundTerminals/terminate") {
          expect(input).toEqual({ threadId: "thread-1", processId: "54527" });
          terminationAttempts += 1;
          if (scenario === "failed stop" && terminationAttempts === 1) {
            throw new Error("Synthetic transport failure");
          }
          if (scenario === "concurrent stop" || scenario === "client closed") {
            if (terminationAttempts > 1) {
              return { terminated: false };
            }
            terminateStarted.resolve();
            await terminateRelease.promise;
          }
          if (scenario === "refused stop") {
            return { terminated: false };
          }
          if (scenario === "source retired during stop") {
            source.abort();
          }
          await harness.notify(
            terminal(
              scenario === "natural success"
                ? 0
                : scenario === "natural failure during stop" ||
                    scenario === "source retired during stop"
                  ? 7
                  : -1,
            ),
          );
          return { terminated: true };
        }
        return undefined;
      });
      const run = runCodexAppServerAttempt(params);
      try {
        await run.waitForTurnAccepted();
        await harness.notify(itemNotification("item/started", command));
        await harness.notify(turnCompleted({ id: "turn-1", status: "completed", items: [] }));
        await run;
        if (!host.agentHarnessTaskRuntimeScope) {
          throw new Error("Expected an admitted task scope");
        }
        const tasks = createAgentHarnessTaskRuntime({
          runtime: "cli",
          scope: host.agentHarnessTaskRuntimeScope,
        });
        expect(tasks.listTaskRecords()).toContainEqual(
          expect.objectContaining({
            taskId: commandTaskId,
            status: "running",
            task: command.command,
            ownerKey: params.sessionKey,
          }),
        );
        retained = true;
        if (!cancelOwner) {
          throw new Error("Expected the registered native cancellation owner");
        }
        if (scenario === "publication failure") {
          const releasedBeforeCompletion = releaseSource.mock.calls.length;
          await expect(harness.notify(terminal(0))).rejects.toThrow(
            "Synthetic terminal publication failure",
          );
          expect(releaseTask).toHaveBeenCalledOnce();
          expect(releaseSource).toHaveBeenCalledTimes(releasedBeforeCompletion + 1);
          expect(finishAttempts).toBe(1);
          expect(terminationAttempts).toBe(0);
          expect(source.signal.aborted).toBe(false);
          // The failed publication has no confirmed durable terminal result.
          expect(tasks.listTaskRecords()).toContainEqual(
            expect.objectContaining({ taskId: commandTaskId, status: "running" }),
          );
          return;
        }
        if (scenario === "client closed") {
          const releasedBeforeStop = releaseSource.mock.calls.length;
          stopAttempts = Promise.allSettled([cancelOwner()]);
          await terminateStarted.promise;
          harness.close();
          terminateRelease.resolve();
          expect(await stopAttempts).toMatchObject([{ status: "rejected" }]);
          expect(releaseTask).toHaveBeenCalledOnce();
          expect(releaseSource).toHaveBeenCalledTimes(releasedBeforeStop + 1);
          expect(tasks.listTaskRecords()).toContainEqual(
            expect.objectContaining({ taskId: commandTaskId, status: "running" }),
          );
          await expect(cancelOwner()).rejects.toThrow();
          return;
        } else if (scenario === "source retired") {
          source.abort();
          await finished.promise;
          await expect(cancelOwner()).rejects.toThrow();
        } else if (scenario === "complete" || scenario === "natural failure") {
          await harness.notify(terminal(scenario === "complete" ? 0 : 7));
        } else if (scenario === "concurrent stop") {
          stopAttempts = Promise.allSettled([cancelOwner(), cancelOwner()]);
          await terminateStarted.promise;
          terminateRelease.resolve();
          const results = await stopAttempts;
          expect(terminationAttempts).toBe(1);
          expect(results).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }]);
        } else if (
          [
            "refused stop",
            "failed stop",
            "changed handle",
            "authority retired during inventory",
          ].includes(scenario)
        ) {
          await expect(cancelOwner()).rejects.toThrow();
          expect(tasks.listTaskRecords()).toContainEqual(
            expect.objectContaining({ taskId: commandTaskId, status: "running" }),
          );
          if (scenario === "failed stop") {
            await cancelOwner();
          } else {
            await harness.notify(terminal(7));
          }
        } else {
          await cancelOwner();
        }
        const expected =
          scenario === "complete" || scenario === "natural success"
            ? "succeeded"
            : scenario === "cancel" || scenario === "concurrent stop" || scenario === "failed stop"
              ? "cancelled"
              : "failed";
        expect(tasks.listTaskRecords()).toContainEqual(
          expect.objectContaining({
            taskId: commandTaskId,
            status: expected,
            task: command.command,
            terminalSummary:
              scenario === "source retired"
                ? "Command outcome unknown"
                : {
                    succeeded: "Command completed",
                    failed: "Command failed",
                    cancelled: "Command stopped",
                  }[expected],
          }),
        );
        if (
          scenario === "changed handle" ||
          scenario === "source retired" ||
          scenario === "authority retired during inventory"
        ) {
          expect(
            harness.requests.some(
              (request) => request.method === "thread/backgroundTerminals/terminate",
            ),
          ).toBe(false);
        }
      } finally {
        terminateRelease.resolve();
        await stopAttempts;
        source.abort();
        harness.close();
        host.closeHost();
        host.closeAdmission();
        await Promise.allSettled([run]);
        admission.mockRestore();
      }
    },
  );
  it.each([
    ["retained", "52627"],
    ["foreign item", "52627"],
    ["foreign process", "52627"],
    ["orphan", "52627"],
    ["completion during inventory", "52627"],
    ["revoked during inventory", "52627"],
    ["inventory unavailable", "52627"],
    ["retained", null],
    ["foreign item", null],
    ["orphan", null],
    ["completion during inventory", null],
    ["revoked during inventory", null],
  ] as const)("projects owner outcome: %s (%s)", async (scenario, startProcessId) => {
    const accepted = createDeferred<void>();
    const abort = new AbortController();
    const params = createTestParams();
    params.abortSignal = abort.signal;
    params.onExecutionPhase = ({ phase }) => {
      if (phase === "turn_accepted") {
        accepted.resolve();
      }
    };
    const command = {
      type: "commandExecution",
      id: "retained-command",
      command: "synthetic-controlled-command",
      cwd: "/workspace",
      processId: startProcessId,
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const harness = createStartedThreadHarness(async (method, input) => {
      if (method !== "thread/backgroundTerminals/list") {
        return undefined;
      }
      expect(input).toMatchObject({ threadId: "thread-1" });
      if (abort.signal.aborted) {
        return { data: [], nextCursor: null };
      }
      if (scenario === "inventory unavailable") {
        throw new Error("Synthetic inventory unavailable");
      }
      if (scenario === "completion during inventory") {
        await harness.notify(
          itemNotification("item/completed", {
            ...command,
            processId: "52627",
            status: "failed",
            exitCode: 7,
            aggregatedOutput: "Synthetic command failed after yielding",
            durationMs: 1,
          }),
        );
      }
      if (scenario === "revoked during inventory") {
        abort.abort(new Error("Synthetic source revoked during inventory"));
      }
      return {
        data:
          scenario === "orphan"
            ? []
            : [
                {
                  itemId: scenario === "foreign item" ? "another-command" : command.id,
                  processId: scenario === "foreign process" ? "another-process" : "52627",
                },
              ],
        nextCursor: null,
      };
    });
    const run = runCodexAppServerAttempt(params);
    try {
      await Promise.race([
        accepted.promise,
        run.then(() => {
          throw new Error("Attempt ended before native turn acceptance");
        }),
      ]);
      await harness.notify(itemNotification("item/started", command));
      await harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "answer",
              type: "agentMessage",
              phase: "final_answer",
              text: "Retained handle 52627.",
            },
          ],
        }),
      );
      const result = await run;
      const tool = result.messagesSnapshot.find(
        (message) => message.role === "toolResult" && message.toolCallId === command.id,
      );
      if (scenario === "retained") {
        expect(tool).toMatchObject({
          isError: false,
          content: [{ type: "text", text: expect.stringContaining("still running") }],
          __openclaw: { toolOutput: { outcome: "unknown" } },
        });
        expect(JSON.stringify(tool)).toContain("52627");
      } else if (scenario === "completion during inventory") {
        expect(tool).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "Synthetic command failed after yielding" }],
        });
        expect(JSON.stringify(tool)).not.toContain('"outcome":"unknown"');
      } else {
        expect(tool).toMatchObject({ isError: true });
        expect(JSON.stringify(tool)).not.toContain('"outcome":"unknown"');
      }
    } finally {
      abort.abort(new Error("fixture cleanup"));
      harness.close();
      await Promise.allSettled([run]);
    }
  });
});
