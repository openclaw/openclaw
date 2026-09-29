import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createAgentHarnessHostCapabilitiesForTest,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import { isJsonObject } from "./protocol.js";
import {
  createTestParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { settleInput } from "./turn-router.test-support.js";

setupRunAttemptTestHooks();

it.each(["refresh", "terminal", "cancel", "confirmation-error", "unconsumed"] as const)(
  "settles host steering without retiring live confirmation during %s",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const params = createTestParams();
    params.agentId = "main";
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    if (!params.sessionKey) {
      throw new Error("Fixture requires a session key");
    }
    const target = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: path.join(tempDir, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: 1 },
    });
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = (text: string) =>
      createRecorder({
        input: { text, idempotencyKey: text },
        target: { ...target, sessionEntry: undefined },
      });
    const A = recorder("A");
    const B = recorder("B");
    await A.persistApproved();
    params.sessionTarget = target;
    params.userTurnTranscriptRecorder = A;
    params.prompt = "A";
    params.suppressNextUserMessagePersistence = true;
    const ready = createDeferred<void>();
    const reloadReported = createDeferred<void>();
    params.onAgentEvent = (event) => {
      if (
        event.stream === "tool" &&
        event.data.phase === "result" &&
        event.data.name === "reload_runtime"
      ) {
        reloadReported.resolve();
      }
    };
    let refreshPending = false;
    params.pluginRuntimeRefreshPending = () => refreshPending;
    params.registerPluginRuntimeRefreshConsumer = () => ready.resolve();
    const reload = createRuntimeDynamicTool("reload_runtime");
    reload.execute = async () => {
      refreshPending = true;
      return { content: [{ type: "text", text: "reloaded" }], details: {} };
    };
    setCodexTestModelSupportsTools(params, true);
    const harness = createStartedThreadHarness(async (method) =>
      method === "thread/unsubscribe" ? { status: "unsubscribed" } : undefined,
    );
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: params,
      pluginId: "codex",
      nativeModelPolicySupport: "exact",
    });
    // The native bridge uses a test tool; input, host binding, confirmation and
    // attempt settlement below are the actual production composition.
    const { setHostToolFactoryForTest } =
      await import("openclaw/plugin-sdk/agent-runtime-test-contracts");
    await setHostToolFactoryForTest(params, () => [reload]);
    const run = host.run(async (prepared) => {
      params.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
      return await runCodexAppServerAttempt(
        { ...params, ...prepared, hostCapabilities: host.capabilities },
        {
          pluginConfig: { appServer: { mode: "yolo" } },
        },
      );
    });
    const settled = run.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const releaseConfirmation = createDeferred<void>();
    let injected: ReturnType<typeof host.injectMessage> | undefined;
    let callerLive = true;
    let runSettled = false;
    void settled.then(() => {
      runSettled = true;
    });
    try {
      await Promise.race([
        ready.promise,
        run.then(() => {
          throw new Error("attempt ended before registration");
        }),
      ]);
      injected = host.injectMessage("B", {
        debounceMs: 0,
        isInboundUserMessage: true,
        waitForTranscriptCommit: true,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        userTurnTranscriptRecorder: B,
        assertCurrent: () => {
          if (!callerLive) {
            throw new Error("steering source revoked");
          }
        },
      });
      // Observe a possible producer rejection without creating an unhandled tail.
      void injected.outcome.catch(() => undefined);
      await harness.waitForMethod("turn/steer");
      await injected.acceptance;
      const before = A.getAdmissionReceipt();
      B.markRuntimePersistencePending(releaseConfirmation.promise);
      const request = harness.requests.find((entry) => entry.method === "turn/steer");
      const clientId = isJsonObject(request?.params)
        ? request.params.clientUserMessageId
        : undefined;
      if (typeof clientId !== "string") {
        throw new Error("Fixture requires the native steering correlation");
      }
      if (scenario !== "unconsumed") {
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "B", type: "userMessage", clientId },
          },
        });
      }
      const refreshing =
        scenario === "refresh" || scenario === "confirmation-error" || scenario === "unconsumed";
      const reloadResponse = refreshing
        ? harness.handleServerRequest({
            id: "reload",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "reload",
              namespace: null,
              tool: "reload_runtime",
              arguments: {},
            },
          })
        : Promise.resolve();
      const reloadSettled = reloadResponse.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (refreshing) {
        await Promise.race([reloadReported.promise, reloadSettled]);
      } else if (scenario === "terminal") {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      } else {
        abort.abort("cancelled");
        await harness.waitForMethod("turn/interrupt");
      }
      if (scenario === "confirmation-error") {
        callerLive = false;
      }
      await settleInput();
      if (scenario !== "cancel" && scenario !== "unconsumed") {
        expect
          .soft(harness.requests.some((entry) => entry.method === "turn/interrupt"))
          .toBe(false);
      }
      if (scenario !== "unconsumed") {
        expect.soft(runSettled).toBe(false);
      }
      expect.soft(A.getAdmissionReceipt()).toEqual(before);
      releaseConfirmation.resolve();
      if (scenario === "cancel" || scenario === "confirmation-error") {
        await expect(injected.outcome).rejects.toThrow();
      } else {
        await expect(injected.outcome).resolves.toMatchObject(
          scenario === "unconsumed"
            ? { status: "accepted", result: { transcriptCommit: "unconfirmed" } }
            : { status: "accepted" },
        );
      }
      await reloadSettled;
      const completed = await settled;
      if (!("result" in completed)) {
        throw completed.error;
      }
      if (scenario === "refresh" || scenario === "terminal") {
        expect(A.getAdmissionReceipt()?.generation).not.toBe(before?.generation);
        expect(B.getAdmissionReceipt()?.generation).toBe(A.getAdmissionReceipt()?.generation);
        expect(B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBe(params.runId);
      } else {
        expect(A.getAdmissionReceipt()).toEqual(before);
        expect(B.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBeUndefined();
      }
      if (scenario === "refresh") {
        expect(completed.result.pluginRuntimeRefreshMessages).toBeDefined();
      }
      if (scenario === "confirmation-error") {
        expect(completed.result.terminal.kind).toBe("failed");
        expect(completed.result.pluginRuntimeRefreshMessages).toBeUndefined();
        expect(harness.requests.some((entry) => entry.method === "turn/interrupt")).toBe(true);
      }
      if (scenario === "cancel") {
        expect(completed.result.terminal.kind).toBe("aborted");
        expect(completed.result.pluginRuntimeRefreshMessages).toBeUndefined();
      }
    } finally {
      releaseConfirmation.resolve();
      await injected?.outcome.catch(() => undefined);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await settled;
      host.close();
    }
  },
);
