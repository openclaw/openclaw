import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import * as admissions from "../sessions/session-lifecycle-admission.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { COMMAND_ADMISSION_OWNER } from "./agent-command-admission-owner.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

it("retains command admission through Code Mode disposal, not detached external settlement", async ({
  signal,
}) => {
  await withStateDirEnv("code-mode-command-isolation-", async () => {
    const name = "command-isolation";
    const target = {
      sessionAgentId: "main",
      isNewSession: false,
      sessionId: `session-code-mode-${name}`,
      sessionKey: `agent:main:${name}`,
      storePath: resolveDefaultSessionStorePath("main"),
    };
    await upsertSessionEntryCore(
      { ...target, agentId: target.sessionAgentId },
      { sessionId: target.sessionId, updatedAt: 1 },
    );
    const manager = SessionManager.open({ ...target, agentId: target.sessionAgentId });
    const harness = createSubscribedCodeModeHarness({ name, sessionManager: manager });
    const successor = createCodeModeHarness({ agentId: "main" });
    const successorRunId = "run-code-mode-command-successor";
    Object.assign(successor.ctx, {
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      runId: successorRunId,
    });
    const rawStarted = createDeferred();
    const releaseRaw = createDeferred();
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const waiting = createDeferred();
    const successorQueued = createDeferred();
    const events: string[] = [];
    const updates = vi.fn();
    let rawWork: Promise<ReturnType<typeof jsonResult>> | undefined;
    let first: Promise<unknown> | undefined;
    let next: Promise<unknown> | undefined;
    let firstSettled = false;
    let rawSettled = false;
    let cleanupSettled = false;
    const lifecycle = vi.spyOn(harness.subscription, "runToolLifecycle");
    const held = pluginToolWithExecute("held_target", "Ignore cancellation", async () => {
      rawWork = (async () => {
        events.push("raw:start");
        rawStarted.resolve();
        await releaseRaw.promise;
        rawSettled = true;
        events.push("raw:settled");
        return jsonResult({ late: true });
      })();
      return await rawWork;
    });
    const late = pluginToolWithExecute("late_target", "Must not run after cancellation", async () =>
      jsonResult({ leaked: true }),
    );
    const effect = pluginToolWithExecute(
      "successor_target",
      "Record a successor effect",
      async () => {
        events.push("successor:effect");
        return jsonResult({ successor: true });
      },
    );
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, held, late] });
    applyCodeModeCatalog({ ...successor.ctx, tools: [...successor.tools, effect] });

    const stopObservingRelease = admissions.observeSessionWorkAdmissionReleases(
      target.storePath,
      () => events.push("admission:released"),
    );
    const beginAdmission = admissions.beginSessionWorkAdmission;
    let commandAdmissions = 0;
    const admissionObserver = vi
      .spyOn(admissions, "beginSessionWorkAdmission")
      .mockImplementation((params) => {
        const acquisition = beginAdmission(params);
        if (params.owner === COMMAND_ADMISSION_OWNER && params.scope === target.storePath) {
          commandAdmissions += 1;
          if (commandAdmissions === 2) {
            events.push("successor:queued");
            successorQueued.resolve();
          }
        }
        return acquisition;
      });
    const execute = <T>(runId: string, run: () => Promise<T>, abortSignal?: AbortSignal) =>
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "claim",
        opts: { message: "Check command isolation", runId, abortSignal },
        prepare: async () => target,
        run,
      });
    try {
      first = execute(
        harness.runId,
        async () => {
          try {
            const parked = resultDetails(
              await expectDefined(harness.tools[0], "exec").execute(
                "first-exec",
                {
                  code: `const pending = held_target({});
                    await yield_control();
                    await pending;
                    console.log("late guest output");
                    return await late_target({});`,
                },
                undefined,
                updates,
              ),
            );
            expect(parked.status).toBe("waiting");
            const owner = expectDefined(
              testing.activeRuns.get(String(parked.runId)),
              "retained Code Mode owner",
            );
            const dispose = owner.continuation.dispose.bind(owner.continuation);
            // Hold the actual worker cleanup, not an unrelated command callback.
            // runWait must join this disposal before command admission can release.
            vi.spyOn(owner.continuation, "dispose").mockImplementation(async () => {
              events.push("cleanup:start");
              cleanupStarted.resolve();
              await releaseCleanup.promise;
              await dispose();
              cleanupSettled = true;
              events.push("cleanup:settled");
            });
            await withinTest(rawStarted.promise, signal);
            const result = expectDefined(harness.tools[1], "wait").execute(
              "first-wait",
              { runId: parked.runId },
              undefined,
              updates,
            );
            // Cancel in this stack before wait can resume the retained guest.
            events.push("command:cancel");
            harness.runAbortController.abort(new Error("Stop this command"));
            waiting.resolve();
            const completed = await result;
            expect(cleanupSettled).toBe(true);
            return resultDetails(completed);
          } finally {
            harness.dispose();
          }
        },
        harness.runAbortController.signal,
      ).finally(() => {
        firstSettled = true;
        events.push("command:settled");
      });
      void first.catch(() => {});
      await withinTest(waiting.promise, signal);
      await withinTest(cleanupStarted.promise, signal);
      expect(events.indexOf("cleanup:start")).toBeGreaterThan(events.indexOf("command:cancel"));

      next = execute(successorRunId, () =>
        runUntilCompleted({
          execTool: expectDefined(successor.tools[0], "successor exec"),
          waitTool: expectDefined(successor.tools[1], "successor wait"),
          code: "return await successor_target({});",
        }),
      );
      void next.catch(() => {});
      await withinTest(successorQueued.promise, signal);
      expect(firstSettled).toBe(false);
      expect(effect.execute).not.toHaveBeenCalled();
      const busy = createGatewayActiveWorkSnapshot();
      expect(busy.idle).toBe(false);
      expect(busy.counts.sessionAdmissions).toBe(1);
      expect(busy.blockers).toContainEqual(
        expect.objectContaining({ kind: "session-admission", count: 1 }),
      );

      releaseCleanup.resolve();
      expect(await withinTest(first, signal)).toMatchObject({ status: "failed", code: "aborted" });
      expect(await withinTest(next, signal)).toMatchObject({
        status: "completed",
        value: { successor: true },
      });
      expect(rawSettled).toBe(false);
      expect(effect.execute).toHaveBeenCalledOnce();
      expect(createGatewayActiveWorkSnapshot().counts.sessionAdmissions).toBe(0);
      expect(events).toEqual(
        expect.arrayContaining(["cleanup:settled", "admission:released", "successor:effect"]),
      );
      expect(events.indexOf("admission:released")).toBeGreaterThan(
        events.indexOf("cleanup:settled"),
      );
      expect(events.indexOf("successor:effect")).toBeGreaterThan(
        events.indexOf("admission:released"),
      );

      const publishedUpdates = updates.mock.calls.length;
      releaseRaw.resolve();
      await withinTest(expectDefined(rawWork, "raw implementation"), signal);
      await Promise.allSettled(lifecycle.mock.results.map((result) => result.value));
      expect(held.execute).toHaveBeenCalledOnce();
      expect(events.filter((event) => event === "raw:settled")).toHaveLength(1);
      expect(late.execute).not.toHaveBeenCalled();
      expect(updates).toHaveBeenCalledTimes(publishedUpdates);
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
    } finally {
      try {
        releaseCleanup.resolve();
        releaseRaw.resolve();
        harness.runAbortController.abort();
        harness.dispose();
        clearToolSearchCatalog(successor.ctx);
        await Promise.allSettled([first, next, rawWork]);
        await Promise.allSettled(lifecycle.mock.results.map((result) => result.value));
        await resetCodeModeTestState();
      } finally {
        stopObservingRelease();
        admissionObserver.mockRestore();
        vi.restoreAllMocks();
      }
    }
  });
});
