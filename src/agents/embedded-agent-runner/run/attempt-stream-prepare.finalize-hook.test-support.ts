import { expect, it, type Mock } from "vitest";
import { Agent } from "../../../../packages/agent-core/src/agent.js";
import { streamMocks } from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  createBeforeFinalizeEvent,
  prepareCatalogExecutor,
} from "./attempt-stream-prepare.test-support.js";

/** before_agent_finalize checks the settled-turn finalizer's answer when its caller grants a budget. */
export function registerSettledFinalizationHookTests(mocks: {
  subscribe: Mock;
  runBeforeFinalizeHook: Mock;
}) {
  it.each([
    ["with the run's revision budget", { maxBeforeAgentFinalizeRevisions: 3 }],
    ["without one", {}],
  ])("checks the settled-turn finalizer's answer %s", async (_label, budget) => {
    const granted = "maxBeforeAgentFinalizeRevisions" in budget;
    if (granted) {
      mocks.runBeforeFinalizeHook.mockResolvedValueOnce({ action: "revise", reason: "Build" });
    }
    const prepared = prepareCatalogExecutor({
      attempt: { operation: "settled-tool-finalization", ...budget },
      activeSession: {
        agent: new Agent({ streamFn: streamMocks.streamSimple }),
        isStreaming: false,
        messages: [],
        pendingMessageCount: 0,
        subscribe: () => () => {},
      } as never,
      hookRunner: { hasHooks: (name: string) => name === "before_agent_finalize" } as never,
    });
    const subscriptionInput = mocks.subscribe.mock.calls.at(-1)?.[0] as {
      onBeforeTerminalDelivery?: (event: unknown) => Promise<unknown>;
    };
    try {
      if (!granted) {
        expect(subscriptionInput.onBeforeTerminalDelivery).toBeUndefined();
        return;
      }
      await expect(
        subscriptionInput.onBeforeTerminalDelivery?.(createBeforeFinalizeEvent()),
      ).resolves.toEqual({ suppressTerminalDelivery: true });
      expect(prepared.getBeforeAgentFinalizeRevisionReason()).toBe("Build");
      expect(prepared.getBeforeAgentFinalizeRevisionEntryId()).toBe("canonical-entry-id");
    } finally {
      prepared.subscription.unsubscribe();
    }
  });
}
