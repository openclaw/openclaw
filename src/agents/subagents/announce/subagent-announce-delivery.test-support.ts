export * from "./subagent-announce-delivery.js";

import { expect, it, vi } from "vitest";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { mockCallArg } from "../../subagent-test-fixtures.test-helpers.js";
import {
  hasAnnounceSendEvidence,
  runAnnounceDeliveryWithRetry,
  SourceOwnerChangedError,
} from "./subagent-announce-delivery-retry.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";

export const testing = {
  setDepsForTest: setSubagentAnnounceDeliveryDepsForTest,
  hasAnnounceSendEvidence,
};

type RunDescendantWake = typeof import("./subagent-announce-descendant-wake.js").runDescendantWake;
type DescendantWakeDeps = Parameters<RunDescendantWake>[0]["deps"];

export function registerDescendantWakeCurrencyTests({
  createRoleRestrictedInProcessGatewayMock,
  createGatewayMock,
  runDescendantWake,
}: {
  runDescendantWake: RunDescendantWake;
  createRoleRestrictedInProcessGatewayMock: (response: Record<string, unknown>) => {
    cfg: ReturnType<DescendantWakeDeps["getRuntimeConfig"]>;
    dispatchGatewayMethodInProcess: DescendantWakeDeps["dispatchGatewayMethodInProcess"];
  };
  createGatewayMock: (response?: Record<string, unknown>) => DescendantWakeDeps["callGateway"];
}) {
  it.each(["current", "changed", "unavailable"] as const)(
    "settles descendant wakes under restrictive gateway roles with %s currency",
    async (currency) => {
      const { cfg, dispatchGatewayMethodInProcess } = createRoleRestrictedInProcessGatewayMock({
        runId: "descendant-wake-run",
      });
      const resolveGatewayContext: GatewayContextResolver = () => undefined;
      const signal = new AbortController().signal;
      const replaceSubagentRunAfterSteer = vi.fn(async () => true);
      let accepted = false;
      const dispatch = vi.mocked(dispatchGatewayMethodInProcess);
      const dispatchWithRoleCheck = dispatch.getMockImplementation()!;
      dispatch.mockImplementation(async (...args) => {
        const response = await dispatchWithRoleCheck(...args);
        accepted = true;
        return response;
      });
      const callGateway = createGatewayMock({
        aborted: true,
        runIds: ["descendant-wake-run"],
      });
      testing.setDepsForTest({
        getRuntimeConfig: () => cfg,
        loadSessionEntryByKey: async () => ({ sessionId: "nested-session", updatedAt: 1 }),
      });

      const woke = await runDescendantWake({
        runId: "nested-parent-run",
        childSessionKey: "agent:main:subagent:nested-parent",
        taskLabel: "collect descendant findings",
        findings: "The descendant completed successfully.",
        announceId: "descendant-completion",
        prepareCurrent: async () => {
          if (accepted && currency === "unavailable") {
            throw new Error("currency reader closed");
          }
          return !accepted || currency === "current";
        },
        isChildSessionEffectsAllowed: () => true,
        hasUsableSessionEntry: (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null,
        resolveGatewayContext,
        signal,
        deps: {
          callGateway,
          dispatchGatewayMethodInProcess,
          getRuntimeConfig: () => cfg,
          replaceSubagentRunAfterSteer,
        },
      });

      expect(woke).toBe(currency === "current");
      expect(mockCallArg(dispatchGatewayMethodInProcess, 0, 2)).toMatchObject({
        cancelOnDeadline: true,
        resolveGatewayContext,
        signal,
      });
      if (currency === "current") {
        expect(callGateway).not.toHaveBeenCalled();
        expect(replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
          expect.objectContaining({
            previousRunId: "nested-parent-run",
            nextRunId: "descendant-wake-run",
          }),
        );
      } else {
        expect(replaceSubagentRunAfterSteer).not.toHaveBeenCalled();
        expect(callGateway).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "chat.abort",
            params: {
              sessionKey: "agent:main:subagent:nested-parent",
              runId: "descendant-wake-run",
            },
          }),
        );
      }
    },
  );

  it.each([1, 3])(
    "refuses a wake retry after %s attempts when currency changes",
    async (attempts) => {
      vi.useFakeTimers();
      let current = true;
      let dispatched = 0;
      const pending = runAnnounceDeliveryWithRetry({
        operation: "descendant wake agent call",
        prepareAttempt: async () => current,
        isAttemptAllowed: () => true,
        run: async () => {
          dispatched += 1;
          current = dispatched < attempts;
          throw new Error("UNAVAILABLE");
        },
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(SourceOwnerChangedError);
      await vi.runAllTimersAsync();
      await rejected;
      expect(dispatched).toBe(attempts);
    },
  );
}
