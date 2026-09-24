import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../process/gateway-work-admission.test-helpers.js";
import { isCompletionReportInputProvenance } from "../sessions/input-provenance.js";
import * as asyncWork from "../shared/async-work-scope.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";
import type { AnyAgentTool } from "./tools/common.js";

type SessionsSendTimeoutFixtures = {
  getSessionTool: (
    name: "sessions_send",
    options: { agentSessionKey: string; agentChannel: string },
  ) => AnyAgentTool;
  callGatewayMock: Mock;
};

export function observeSessionSendContinuations(options: { trackAllWork?: boolean } = {}) {
  const completions = new Set<Promise<unknown>>();
  const continuationWork = new AsyncLocalStorage<boolean>();
  const originalTrack = asyncWork.trackAsyncWork;
  const workSpy = vi.spyOn(asyncWork, "trackAsyncWork").mockImplementation(function observeWork<T>(
    run: () => T | Promise<T>,
  ): Promise<T> {
    const completion = originalTrack(run);
    if (options.trackAllWork || continuationWork.getStore()) {
      completions.add(completion);
    }
    return completion;
  });
  const original = gatewayWorkAdmission.runWithGatewayDetachedWorkContinuation;
  const spy = vi
    .spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkContinuation")
    .mockImplementation(function observe<T>(run: () => Promise<T>, origin?: string): Promise<T> {
      const completion = original(
        origin === "session:a2a-send" ? () => continuationWork.run(true, run) : run,
        origin,
      );
      if (origin === "session:a2a-send") {
        completions.add(completion);
      }
      return completion;
    });
  let joining: Promise<void> | undefined;

  return {
    settle(): Promise<void> {
      if (joining) {
        return joining;
      }
      joining = (async () => {
        const failures: unknown[] = [];
        while (completions.size > 0) {
          const batch = [...completions];
          const results = await Promise.allSettled(batch);
          for (const completion of batch) {
            completions.delete(completion);
          }
          for (const result of results) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }
        }
        if (failures.length === 1 && failures[0] instanceof Error) {
          throw failures[0];
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "sessions_send continuation cleanup failed");
        }
      })().finally(() => {
        joining = undefined;
      });
      return joining;
    },
    restore() {
      spy.mockRestore();
      workSpy.mockRestore();
      continuationWork.disable();
    },
  };
}

export function registerSessionsSendPendingErrorTest({
  getSessionTool,
  callGatewayMock,
  settleContinuations,
}: SessionsSendTimeoutFixtures & { settleContinuations: () => Promise<void> }) {
  it("sessions_send returns pending agent error diagnostics on timeout", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const continuationWaiting = createDeferred();
    const pendingRunCompleted = createDeferred();
    let waitCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return {
          runId: "run-pending-model-error",
          status: "accepted",
          acceptedAt: 1234,
        };
      }
      if (request.method === "agent.wait") {
        if (++waitCount > 1) {
          continuationWaiting.resolve();
          await pendingRunCompleted.promise;
          return {
            runId: "run-pending-model-error",
            status: "ok",
            terminalReply: { disposition: "silent" },
          };
        }
        return {
          runId: "run-pending-model-error",
          status: "timeout",
          error: "429 RESOURCE_EXHAUSTED",
          pendingError: true,
        };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: "discord:group:req",
      agentChannel: "discord",
    });
    await runQaGatewayFixture(
      async () => {
        const result = await tool.execute("call-pending-error", {
          sessionKey: "main",
          message: "check status",
          timeoutSeconds: 1,
        });
        expect(result.details).toMatchObject({
          status: "timeout",
          error: "429 RESOURCE_EXHAUSTED",
          runId: "run-pending-model-error",
          sentBeforeError: true,
          delivery: { status: "pending" },
        });
        expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
        await continuationWaiting.promise;
        expect(calls.filter((call) => call.method === "agent.wait").length).toBeGreaterThanOrEqual(
          2,
        );
        expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(1);
      },
      () => pendingRunCompleted.resolve(),
      settleContinuations,
    );
  });
}

export function registerSessionsSendTimeoutTests({
  getSessionTool,
  callGatewayMock,
}: SessionsSendTimeoutFixtures) {
  it.each([
    {
      name: "terminal timeout with an explicit diagnostic",
      waitResult: {
        status: "timeout",
        endedAt: 3000,
        stopReason: "timeout",
        error: "agent run timed out",
      },
      expectedError: "agent run timed out",
    },
    {
      name: "terminal timeout with a provider-specific diagnostic",
      waitResult: {
        status: "timeout",
        endedAt: 3000,
        stopReason: "timeout",
        error: "provider request exceeded its deadline",
      },
      expectedError: "provider request exceeded its deadline",
    },
    {
      name: "provider-attributed terminal timeout without a diagnostic",
      waitResult: {
        status: "ok",
        endedAt: 3000,
        timeoutPhase: "provider",
        providerStarted: true,
      },
      expectedError: "agent run timed out",
    },
  ] as const)(
    "sessions_send preserves a $name through Tool Search without starting A2A",
    async ({ waitResult, expectedError }) => {
      const calls: Array<{ method?: string; params?: unknown }> = [];
      const requesterKey = "agent:main:main";
      const targetKey = "agent:director1:main";
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: unknown };
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-terminal", status: "accepted", acceptedAt: 2000 };
        }
        if (request.method === "agent.wait") {
          return { runId: "run-terminal", ...waitResult };
        }
        return {};
      });

      const tool = getSessionTool("sessions_send", {
        agentSessionKey: requesterKey,
        agentChannel: "discord",
      });
      const catalogRef = createToolSearchCatalogRef();
      registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool] });
      const runtime = new ToolSearchRuntime(
        { catalogRef },
        resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "tools" } } }),
        { validateInput: true },
      );

      const details = await runtime.callValue("sessions_send", {
        sessionKey: targetKey,
        message: "ping",
        timeoutSeconds: 1,
      });
      expect(details).toEqual({
        runId: "run-terminal",
        status: "timeout",
        error: expectedError,
        sentBeforeError: true,
        sessionKey: targetKey,
      });
      expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
      expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(1);
    },
  );
}

export function registerSessionsSendLateReplyTests({
  getSessionTool,
  callGatewayMock,
  settleContinuations,
}: SessionsSendTimeoutFixtures & { settleContinuations: () => Promise<void> }) {
  it.each<{
    targetKind: string;
    targetKey: string;
    spawned: boolean;
    timeoutSeconds?: number;
    pendingError?: boolean;
    failure?: string;
    stopReason?: string;
    cronRequester?: boolean;
  }>([
    { targetKind: "peer", targetKey: "agent:director1:main", spawned: false },
    { targetKind: "visible child", targetKey: "agent:director1:dashboard:child", spawned: true },
    { targetKind: "hidden child", targetKey: "agent:director1:subagent:child", spawned: true },
    {
      targetKind: "nonblocking child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      timeoutSeconds: 0,
    },
    {
      targetKind: "retrying child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      pendingError: true,
    },
    {
      targetKind: "failed child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      failure: "child run failed",
    },
    {
      targetKind: "failed retrying child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      pendingError: true,
      failure: "child retry exhausted",
    },
    {
      targetKind: "cancelled child",
      targetKey: "agent:director1:subagent:child",
      spawned: true,
      failure: "child run cancelled",
      stopReason: "aborted",
    },
    ...["dashboard", "subagent"].flatMap((kind) =>
      [0, 1].flatMap((timeoutSeconds) =>
        [false, true].map((failed) => ({
          targetKind: `${kind} child of Cron, timeout=${timeoutSeconds}, failed=${failed}`,
          targetKey: `agent:director1:${kind}:child`,
          spawned: true,
          cronRequester: true,
          timeoutSeconds,
          failure: failed ? "Cron child run failed" : undefined,
        })),
      ),
    ),
  ])(
    "sessions_send delivers the late reply from a $targetKind after the parent root releases",
    async ({
      targetKey,
      spawned,
      timeoutSeconds = 1,
      pendingError,
      failure,
      stopReason,
      cronRequester = false,
    }) => {
      const calls: Array<{ method?: string; params?: unknown }> = [];
      const requesterKey = cronRequester ? "agent:main:cron:job:run:once" : "agent:main:main";
      if (spawned) {
        await upsertSessionEntryCore(
          { agentId: "director1", sessionKey: targetKey },
          { sessionId: "child-session", updatedAt: 1, spawnedBy: requesterKey, spawnDepth: 1 },
        );
      }
      let targetWaitCount = 0;
      let releaseDelayedWait = () => {};
      const delayedWaitGate = new Promise<void>((resolve) => {
        releaseDelayedWait = resolve;
      });
      let requesterProviderStarts = 0;
      let requesterAdmissionClosed: boolean | undefined;
      let finalAnnounceProviderStarts = 0;
      let finalAnnounceAdmissionClosed: boolean | undefined;
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: unknown };
        calls.push(request);
        if (request.method === "agent") {
          const params = request.params as { sessionKey?: string } | undefined;
          if (params?.sessionKey === targetKey) {
            return { runId: "run-target", status: "accepted", acceptedAt: 2000 };
          }
          if (params?.sessionKey === requesterKey) {
            requesterAdmissionClosed =
              gatewayWorkAdmission.isGatewaySubordinateWorkAdmissionClosed();
            if (requesterAdmissionClosed) {
              throw new gatewayWorkAdmission.GatewayDrainingError();
            }
            requesterProviderStarts += 1;
            return { runId: "run-requester", status: "accepted", acceptedAt: 2001 };
          }
        }
        if (request.method === "agent.wait") {
          const params = request.params as { runId?: string } | undefined;
          if (params?.runId === "run-target") {
            targetWaitCount += 1;
            if (timeoutSeconds !== 0 && targetWaitCount === 1) {
              return {
                runId: "run-target",
                status: "timeout",
                ...(pendingError ? { pendingError: true, error: "retrying provider" } : {}),
              };
            }
            await delayedWaitGate;
            if (failure) {
              return { runId: "run-target", status: "error", error: failure, stopReason };
            }
            return {
              runId: "run-target",
              status: "ok",
              terminalReply: { disposition: "visible", text: "late director reply" },
            };
          }
          if (params?.runId === "run-requester") {
            return {
              runId: "run-requester",
              status: "ok",
              terminalReply: { disposition: "visible", text: "requester saw director" },
            };
          }
        }
        return {};
      });
      await agentStepTesting.setDepsForTest({
        agentCommandFromIngress: async (opts) => {
          expect(opts.sessionKey).toBe(targetKey);
          expect(opts.extraSystemPrompt).toContain("Agent-to-agent announce step");
          finalAnnounceAdmissionClosed =
            gatewayWorkAdmission.isGatewaySubordinateWorkAdmissionClosed();
          if (finalAnnounceAdmissionClosed) {
            throw new gatewayWorkAdmission.GatewayDrainingError();
          }
          finalAnnounceProviderStarts += 1;
          return {
            payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
            meta: { durationMs: 1 },
          };
        },
      });

      const tool = getSessionTool("sessions_send", {
        agentSessionKey: requesterKey,
        agentChannel: "discord",
      });

      await runQaGatewayFixture(async () => {
        const parentWork = new asyncWork.AsyncWorkScope();
        const result = await runWithGatewayRootWorkAdmissionForTest(async () => {
          try {
            return await parentWork.track(() =>
              tool.execute("call-delayed", {
                sessionKey: targetKey,
                message: "ping",
                timeoutSeconds,
              }),
            );
          } finally {
            await asyncWork.AsyncWorkScope.runWhenAllIdle(
              () => [parentWork],
              () => parentWork.drain(),
            );
          }
        });
        expect(result.details).toMatchObject({
          status: pendingError ? "timeout" : "accepted",
          sessionKey: targetKey,
          ...(!pendingError ? { targetDisposition: "queued" } : {}),
          delivery: { status: "pending", mode: "announce" },
        });
        expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(1);
        expect(requesterProviderStarts).toBe(0);
        releaseDelayedWait();

        if (!cronRequester) {
          await vi.waitFor(
            () => {
              expect(requesterAdmissionClosed).toBe(false);
            },
            { timeout: 2_000, interval: 5 },
          );
        }
        await settleContinuations();
        await vi.waitFor(() => {
          expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
        });
        expect(requesterProviderStarts).toBe(cronRequester ? 0 : spawned ? 1 : 3);

        const requesterReplyCall = calls.find(
          (call) =>
            call.method === "agent" &&
            (call.params as { sessionKey?: string } | undefined)?.sessionKey === requesterKey,
        );
        if (cronRequester) {
          expect(requesterReplyCall).toBeUndefined();
          expect(requesterAdmissionClosed).toBeUndefined();
          expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
        } else {
          const replyParams = requesterReplyCall?.params as
            | {
                extraSystemPrompt?: string;
                inputProvenance?: { sourceSessionKey?: string; sourceRole?: string };
                message?: string;
                sessionKey?: string;
              }
            | undefined;
          expect(replyParams?.sessionKey).toBe(requesterKey);
          expect(replyParams?.inputProvenance?.sourceSessionKey).toBe(targetKey);
          expect(replyParams?.message).toContain(failure ?? "late director reply");
          expect(replyParams?.inputProvenance?.sourceRole).toBe(spawned ? "subagent" : undefined);
          expect(
            isCompletionReportInputProvenance(replyParams?.inputProvenance),
            "requested child results use the completion boundary so parent answers remain visible",
          ).toBe(spawned);
          if (spawned) {
            expect(replyParams?.extraSystemPrompt).not.toContain("REPLY_SKIP");
          } else {
            expect(replyParams?.extraSystemPrompt).toContain("Agent-to-agent reply step");
            expect(replyParams?.extraSystemPrompt).toContain("Current agent: Agent 1 (requester)");
          }
        }
        expect(calls.find((call) => call.method === "send")).toBeUndefined();
        const announces = !spawned || (cronRequester && !failure);
        expect(finalAnnounceAdmissionClosed).toBe(announces ? false : undefined);
        expect(finalAnnounceProviderStarts).toBe(announces ? 1 : 0);
      }, releaseDelayedWait);
    },
  );
}
