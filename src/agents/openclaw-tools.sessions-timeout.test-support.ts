import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
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

export function observeSessionSendContinuations() {
  const completions = new Set<Promise<unknown>>();
  const original = gatewayWorkAdmission.runWithGatewayDetachedWorkContinuation;
  const spy = vi
    .spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkContinuation")
    .mockImplementation(function observe<T>(run: () => Promise<T>, origin?: string): Promise<T> {
      const completion = original(run, origin);
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
