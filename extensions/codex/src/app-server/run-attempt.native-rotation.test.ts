import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { loadNodeExecAvailability } from "openclaw/plugin-sdk/node-selection-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  directSpawnItem,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import {
  createTestParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  sessionBindingIdentity,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();
vi.mock("openclaw/plugin-sdk/node-selection-runtime", { spy: true });

// Native RPC and the final delivery sink are fixed I/O fixtures; Codex binding
// inventory is in memory. SQLite session authority, monitor restoration, and
// model admission run through their production owners.
it.each(["startup", "projected input", "failed start", "no pressure"] as const)(
  "preserves active native child custody across the next parent attempt (%s)",
  async (scenario) => {
    vi.mocked(loadNodeExecAvailability).mockResolvedValue({
      cacheKey: "[]",
      isAvailable: () => false,
    });
    const attemptAbortController = new AbortController();
    const attemptParams = createTestParams();
    attemptParams.agentId = "main";
    attemptParams.abortSignal = attemptAbortController.signal;
    const agentDir = path.join(tempDir, "rotation-agent");
    attemptParams.agentDir = agentDir;
    await attachSqliteSessionTarget(
      attemptParams,
      resolveStorePath(undefined, { agentId: "main" }),
      "session-1",
    );
    attemptParams.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(attemptParams, true);
    const admittedHostFixture = await createAdmittedHostCapabilityTestFixture(attemptParams, {
      nativeModelPolicySupport: "exact",
      gatewayContext: true,
    });
    assert(admittedHostFixture.agentHarnessCompletionScope);
    attemptParams.hostCapabilities = admittedHostFixture.hostCapabilities;
    attemptParams.agentHarnessCompletionScope = admittedHostFixture.agentHarnessCompletionScope;
    const monitorRegistrationSpy = vi.spyOn(codexNativeSubagentMonitorRuntime, "register");
    const completionDeliverySpy = vi
      .spyOn(defaultNativeSubagentMonitorRuntime, "deliverAgentHarnessCompletion")
      .mockResolvedValue({ delivered: true, path: "direct" });
    const completionSettlements: Promise<void>[] = [];
    // oxlint-disable-next-line typescript/unbound-method
    const deliverPendingCompletion = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
    vi.spyOn(CodexNativeSubagentCompletionDelivery.prototype, "deliverPending").mockImplementation(
      function (this: CodexNativeSubagentCompletionDelivery, monitorState, childAssignment) {
        const completionSettlement = deliverPendingCompletion.call(
          this,
          monitorState,
          childAssignment,
        );
        completionSettlements.push(completionSettlement);
        return completionSettlement;
      },
    );
    let threadStartCount = 0;
    const appServerHarness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        threadStartCount += 1;
        if (threadStartCount > 1) {
          expect(await readCodexAppServerBinding(attemptParams.sessionFile)).toMatchObject({
            threadId: "parent-thread",
          });
          if (scenario === "failed start") {
            throw new Error("synthetic successor start failed");
          }
        }
        return threadStartResult(threadStartCount === 1 ? "parent-thread" : "rotated-parent");
      }
      if (method === "thread/resume") {
        return threadStartResult("parent-thread");
      }
      if (method === "thread/read") {
        return threadRead({ turnId: "child-turn", status: "inProgress", threadStatus: "active" });
      }
      return undefined;
    });
    const captureChildModelSource = () =>
      codexNativeSubagentMonitorRuntime.captureModelSource({
        client: appServerHarness.client,
        threadId: "child-thread",
        turnId: "child-turn",
        parentThreadId: "parent-thread",
        parentTurnId: "turn-1",
        rootTurnId: "turn-1",
      });
    const attemptRuns: ReturnType<typeof runCodexAppServerAttempt>[] = [];
    const runRotationScenario = async () => {
      const initialAttempt = runCodexAppServerAttempt(attemptParams);
      attemptRuns.push(initialAttempt);
      await initialAttempt.waitForTurnAccepted();
      await appServerHarness.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          item: { id: "spawn-child", ...directSpawnItem("v1", "parent-thread", "child-thread") },
        },
      });
      await appServerHarness.notify({
        method: "rawResponseItem/completed",
        params: {
          threadId: "parent-thread",
          turnId: "turn-1",
          item: {
            type: "function_call_output",
            call_id: "spawn-child",
            output: JSON.stringify({ agent_id: "child-thread" }),
          },
        },
      });
      await appServerHarness.notify(turnStartedNotification("child-turn"));
      const initialChildCapture = await captureChildModelSource();
      assert(initialChildCapture, "The child must be admitted before rotation");
      initialChildCapture.assertCurrent();
      initialChildCapture.release();
      const initialAssignments =
        await monitorRegistrationSpy.mock.calls[0]?.[0].assignmentStore?.read();
      const originalHistoryOwner = monitorRegistrationSpy.mock.calls[0]?.[0].historyOwner;
      assert(originalHistoryOwner);
      expect(initialAssignments).toEqual([
        expect.objectContaining({
          childThreadId: "child-thread",
          nativeParentThreadId: "parent-thread",
        }),
      ]);
      await appServerHarness.completeTurn({ threadId: "parent-thread", turnId: "turn-1" });
      expect(readAttemptTerminal(await initialAttempt)).toMatchObject({
        aborted: false,
        promptError: null,
      });

      expect(isCodexAppServerLiveThreadProtected(appServerHarness.client, "parent-thread")).toBe(
        true,
      );
      expect(hasCodexAppServerLiveThread(appServerHarness.client, "parent-thread")).toBe(true);

      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-parent-thread.jsonl"),
        `${JSON.stringify({
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                total_tokens:
                  scenario === "no pressure"
                    ? 10_000
                    : scenario === "projected input"
                      ? 100_000
                      : 120_000,
              },
              model_context_window: 128_000,
            },
          },
        })}\n`,
      );
      const successorAttempt = runCodexAppServerAttempt({
        ...attemptParams,
        runId: "rotation-successor",
        prompt: scenario === "projected input" ? "next input ".repeat(5_000) : "continue",
      });
      attemptRuns.push(successorAttempt);
      if (scenario === "failed start") {
        await expect(successorAttempt).rejects.toThrow("synthetic successor start failed");
        expect(await readCodexAppServerBinding(attemptParams.sessionFile)).toMatchObject({
          threadId: "parent-thread",
        });
        // Generic startup failure retires this fixture's direct client and its
        // monitor capabilities. Only the binding inventory remains authoritative;
        // this row does not prove shared-client child admission after failure.
        expect(
          await testCodexAppServerBindingStore.readNativeSubagentAssignments?.(
            sessionBindingIdentity(attemptParams),
            originalHistoryOwner,
          ),
        ).toEqual(initialAssignments);
        return;
      }
      await successorAttempt.waitForTurnAccepted();
      const successorThreadId = scenario === "no pressure" ? "parent-thread" : "rotated-parent";
      expect(await readCodexAppServerBinding(attemptParams.sessionFile)).toMatchObject({
        threadId: successorThreadId,
      });
      expect(threadStartCount).toBe(scenario === "no pressure" ? 1 : 2);
      expect(isCodexAppServerLiveThreadProtected(appServerHarness.client, "parent-thread")).toBe(
        true,
      );
      expect(hasCodexAppServerLiveThread(appServerHarness.client, "parent-thread")).toBe(true);
      expect(
        appServerHarness.requests
          .filter((request) => request.method === "thread/unsubscribe")
          .map((request) => request.params),
      ).not.toContainEqual(expect.objectContaining({ threadId: "parent-thread" }));
      expect(monitorRegistrationSpy.mock.calls[1]?.[0].historyOwner).toEqual({
        ...originalHistoryOwner,
        parentThreadId: successorThreadId,
      });
      expect(await monitorRegistrationSpy.mock.calls[1]?.[0].assignmentStore?.read()).toEqual(
        initialAssignments,
      );
      expect(appServerHarness.requests.some((request) => request.method === "thread/read")).toBe(
        true,
      );
      const resumedChildCapture = await captureChildModelSource();
      assert(resumedChildCapture, "The child must remain admitted after rotation");
      resumedChildCapture.assertCurrent();
      resumedChildCapture.release();
      await appServerHarness.completeTurn({ threadId: successorThreadId, turnId: "turn-1" });
      expect(readAttemptTerminal(await successorAttempt)).toMatchObject({
        aborted: false,
        promptError: null,
      });
      // The child completes only after the successor has restored its custody.
      const childCompletion = childTurnCompletedNotification({
        status: "completed",
        items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Child result" }],
      });
      await appServerHarness.notify(childCompletion);
      await Promise.all(completionSettlements);
      // Replayed terminal notifications must not deliver the restored assignment twice.
      await appServerHarness.notify(childCompletion);
      await Promise.all(completionSettlements);
      expect(isCodexAppServerLiveThreadProtected(appServerHarness.client, "parent-thread")).toBe(
        false,
      );
      expect(hasCodexAppServerLiveThread(appServerHarness.client, "parent-thread")).toBe(true);
      expect(
        completionDeliverySpy.mock.calls.filter(
          ([completionCall]) => completionCall.result === "Child result",
        ),
      ).toHaveLength(1);
    };
    try {
      // Real completion custody is captured inside an admitted tool/Gateway scope.
      const rotationTestTool = admittedHostFixture.hostCapabilities.bindToolSurface([
        {
          name: "test_native_rotation",
          label: "Test native rotation",
          description: "Exercise parent rotation under the production admission boundary",
          parameters: Type.Object({}),
          execute: async () => {
            await runRotationScenario();
            return { content: [{ type: "text", text: "verified" }], details: {} };
          },
        },
      ])[0];
      assert(rotationTestTool);
      await admittedHostFixture.runWithGatewayScope(() =>
        rotationTestTool.execute("rotation-test", {}),
      );
    } finally {
      attemptAbortController.abort("test_cleanup");
      appServerHarness.close();
      await Promise.allSettled([...attemptRuns, ...completionSettlements]);
      admittedHostFixture.closeHost();
      admittedHostFixture.closeAdmission();
      admittedHostFixture.closeGateway();
    }
  },
);
