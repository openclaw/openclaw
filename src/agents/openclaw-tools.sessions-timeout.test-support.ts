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
import type { AnyAgentTool } from "./tools/common.js";

type SessionsSendTimeoutFixtures = {
  getSessionTool: (
    name: "sessions_send",
    options: { agentSessionKey: string; agentChannel: string },
  ) => AnyAgentTool;
  callGatewayMock: Mock;
};
type GatewayRequest = {
  method?: string;
  params?: {
    sessionKey?: string;
    runId?: string;
    extraSystemPrompt?: string;
    message?: string;
    inputProvenance?: { sourceSessionKey?: string; sourceRole?: string };
  };
};
const requesterKey = "agent:main:main";
const sendInput = (sessionKey: string) => ({ sessionKey, message: "ping", timeoutSeconds: 1 });
const accepted = (runId: string, acceptedAt: number) => ({ runId, status: "accepted", acceptedAt });
const reply = (runId: string, text: string) => ({
  runId,
  status: "ok",
  terminalReply: { disposition: "visible", text },
});
const sendTool = ({ getSessionTool }: SessionsSendTimeoutFixtures) =>
  getSessionTool("sessions_send", { agentSessionKey: requesterKey, agentChannel: "discord" });

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
      if (options.trackAllWork || origin === "session:a2a-send") {
        completions.add(completion);
      }
      return completion;
    });
  let joining: Promise<void> | undefined;

  return {
    settle(): Promise<void> {
      return (joining ??= (async () => {
        const failures: unknown[] = [];
        while (completions.size > 0) {
          const batch = [...completions];
          const results = await Promise.allSettled(batch);
          batch.forEach((completion) => completions.delete(completion));
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
      }));
    },
    restore() {
      spy.mockRestore();
      workSpy.mockRestore();
      continuationWork.disable();
    },
  };
}

export function registerSessionsSendTimeoutTests(fixtures: SessionsSendTimeoutFixtures) {
  const { callGatewayMock } = fixtures;
  it("sessions_send preserves a provider-attributed terminal timeout without a diagnostic through Tool Search without starting A2A", async () => {
    const calls: GatewayRequest[] = [];
    const targetKey = "agent:director1:main";
    await upsertSessionEntryCore(
      { agentId: "director1", sessionKey: targetKey },
      { sessionId: "timeout-target", updatedAt: 1 },
    );
    callGatewayMock.mockImplementation(async (request: GatewayRequest) => {
      calls.push(request);
      if (request.method === "agent") {
        return accepted("run-terminal", 2000);
      }
      if (request.method === "agent.wait") {
        return {
          runId: "run-terminal",
          status: "ok",
          endedAt: 3000,
          timeoutPhase: "provider",
          providerStarted: true,
        };
      }
      return {};
    });

    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [sendTool(fixtures)] });
    const runtime = new ToolSearchRuntime(
      { catalogRef },
      resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "tools" } } }),
      { validateInput: true },
    );

    const details = await runtime.callValue("sessions_send", sendInput(targetKey));
    expect(details).toEqual({
      runId: "run-terminal",
      status: "timeout",
      error: "agent run timed out",
      sentBeforeError: true,
      sessionKey: targetKey,
    });
    expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(1);
  });
}

export function registerSessionsSendLateReplyTests(
  fixtures: SessionsSendTimeoutFixtures & { settleContinuations: () => Promise<void> },
) {
  const { callGatewayMock, settleContinuations } = fixtures;
  it.each<[string, boolean, boolean, string?]>([
    ["peer", false, false],
    ["retrying child", true, true],
    ["cancelled child", true, false, "child run cancelled"],
  ])(
    "sessions_send delivers the late reply from a %s after the parent root releases",
    async (_targetKind, spawned, pendingError, failure) => {
      const targetKey = spawned ? "agent:director1:subagent:child" : "agent:director1:main";
      const calls: GatewayRequest[] = [];
      await upsertSessionEntryCore(
        { agentId: "director1", sessionKey: targetKey },
        {
          sessionId: "child-session",
          updatedAt: 1,
          ...(spawned ? { spawnedBy: requesterKey, spawnDepth: 1 } : {}),
        },
      );
      let targetWaitCount = 0;
      const delayedWaitGate = createDeferred();
      let requesterProviderStarts = 0;
      let requesterAdmissionClosed: boolean | undefined;
      callGatewayMock.mockImplementation(async (request: GatewayRequest) => {
        calls.push(request);
        const { method, params } = request;
        if (method === "agent" && params?.sessionKey === targetKey) {
          return accepted("run-target", 2000);
        }
        if (method === "agent" && params?.sessionKey === requesterKey) {
          requesterAdmissionClosed = gatewayWorkAdmission.isGatewaySubordinateWorkAdmissionClosed();
          if (requesterAdmissionClosed) {
            throw new gatewayWorkAdmission.GatewayDrainingError();
          }
          requesterProviderStarts += 1;
          return accepted("run-requester", 2001);
        }
        if (method === "agent.wait" && params?.runId === "run-target") {
          targetWaitCount += 1;
          if (targetWaitCount === 1) {
            return {
              runId: "run-target",
              status: "timeout",
              ...(pendingError ? { pendingError: true, error: "retrying provider" } : {}),
            };
          }
          await delayedWaitGate.promise;
          return failure
            ? { runId: "run-target", status: "error", error: failure, stopReason: "aborted" }
            : reply("run-target", "late director reply");
        }
        if (method === "agent.wait" && params?.runId === "run-requester") {
          return reply("run-requester", "requester saw director");
        }
        return {};
      });

      const tool = sendTool(fixtures);

      await runQaGatewayFixture(async () => {
        const parentWork = new asyncWork.AsyncWorkScope();
        const result = await runWithGatewayRootWorkAdmissionForTest(async () => {
          try {
            return await parentWork.track(() => tool.execute("call-delayed", sendInput(targetKey)));
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
          delivery: { status: "pending" },
        });
        expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(1);
        expect(requesterProviderStarts).toBe(0);
        delayedWaitGate.resolve();

        await vi.waitFor(() => expect(requesterAdmissionClosed).toBe(false), {
          timeout: 2_000,
          interval: 5,
        });
        await settleContinuations();
        await vi.waitFor(() =>
          expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0),
        );
        expect(requesterProviderStarts).toBe(1);

        const replyParams = calls.find(
          (call) => call.method === "agent" && call.params?.sessionKey === requesterKey,
        )?.params;
        expect(replyParams?.sessionKey).toBe(requesterKey);
        expect(replyParams?.inputProvenance?.sourceSessionKey).toBe(targetKey);
        expect(replyParams?.message).toContain(failure ?? "late director reply");
        expect(replyParams?.inputProvenance?.sourceRole).toBe(spawned ? "subagent" : undefined);
        expect(
          isCompletionReportInputProvenance(replyParams?.inputProvenance),
          "requested child results use the completion boundary so parent answers remain visible",
        ).toBe(spawned);
        if (!failure) {
          expect(replyParams?.extraSystemPrompt).toContain("This result is delivered once");
        }
        expect(calls.find((call) => call.method === "send")).toBeUndefined();
      }, delayedWaitGate.resolve);
    },
  );
}
