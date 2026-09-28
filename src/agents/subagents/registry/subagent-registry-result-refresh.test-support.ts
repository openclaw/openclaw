import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  mockGatewayMethods,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";

export function registerSubagentResultRefreshCases(params: {
  getRegistry: () => SubagentRegistryHarness;
  getLifecycleHandler: () => (event: AgentEventPayload) => void;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "callGateway" | "captureSubagentCompletionReply" | "persistSubagentRunsToDisk"
  >;
}) {
  const { getRegistry, getLifecycleHandler, mocks } = params;
  it.each([false, true])(
    "tracks missing-entry lifecycle result refresh until capture and persistence settle (restart drain: %s)",
    async (draining) => {
      const mod = getRegistry();
      const childSessionKey = "agent:main:subagent:refresh-admission";
      const waitStarted = createDeferred();
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": () => {
          waitStarted.resolve();
          return { status: "pending" };
        },
      });
      await mod.registerSubagentRun({
        runId: "run-refresh-admission-old",
        childSessionKey,
        task: "capture replacement completion",
        expectsCompletionMessage: true,
      });
      await waitStarted.promise;
      expect(mocks.callGateway).toHaveBeenCalled();
      const entry = mod.getSubagentRunByChildSessionKey(childSessionKey);
      expect(entry).not.toBeNull();
      if (entry) {
        entry.execution = {
          ...entry.execution,
          status: "terminal",
          endedAt: Date.now(),
          outcome: { status: "ok" },
        };
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      const captureStarted = createDeferred();
      const capture = createDeferred<string>();
      const persisted = createDeferred();
      mocks.captureSubagentCompletionReply.mockImplementationOnce(() => {
        captureStarted.resolve();
        return capture.promise;
      });
      mocks.persistSubagentRunsToDisk.mockClear();
      mocks.persistSubagentRunsToDisk.mockImplementationOnce(() => persisted.resolve());
      const lifecycleHandler = getLifecycleHandler();

      const emitEnd = () => {
        lifecycleHandler({
          runId: "run-refresh-admission-new",
          seq: 1,
          stream: "lifecycle",
          ts: Date.now(),
          sessionKey: childSessionKey,
          data: { phase: "end" },
        });
      };
      try {
        if (draining) {
          const parent = expectDefined(
            tryBeginGatewayRootWorkAdmission("replacement-run"),
            "replacement root",
          );
          try {
            await parent.run(async () => {
              markGatewayRestartDraining();
              emitEnd();
            });
          } finally {
            parent.release();
          }
        } else {
          emitEnd();
        }

        expect(getActiveGatewayRootWorkCount()).toBe(1);
        await captureStarted.promise;
        expect(mocks.captureSubagentCompletionReply).toHaveBeenCalledOnce();
        expect(entry?.completion?.resultText).toBeUndefined();

        capture.resolve("replacement final reply");
        await persisted.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(entry?.completion?.resultText).toBe("replacement final reply");
        expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalledOnce();
      } finally {
        capture.resolve("replacement final reply");
        await vi.advanceTimersByTimeAsync(0);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  );
}
