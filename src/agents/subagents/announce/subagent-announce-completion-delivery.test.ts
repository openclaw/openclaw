import { describe, expect, it, vi } from "vitest";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../../../gateway/operator-tool-gateway-authority.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
// Completion predicates read recorded facts, not rendered placeholder wording.
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { hasFailedSubagentNoOutputCompletion } from "../../internal-event-contract.js";
import { runAnnounceAgentCall } from "./subagent-announce-completion-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";

const failedChild = { type: "task_completion", source: "subagent", status: "error" } as const;

it("does not dispatch a private handoff after its caller has already cancelled", async () => {
  const caller = new AbortController();
  caller.abort(new Error("requester stopped"));
  const dispatch = vi.fn(async () => {
    throw new Error("cancelled dispatch must not start");
  });
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
  try {
    await expect(
      runAnnounceAgentCall({
        agentParams: {},
        privateCompletion: true,
        signal: caller.signal,
        isExecutionAllowed: () => true,
      }),
    ).rejects.toThrow("requester stopped");
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    setSubagentAnnounceDeliveryDepsForTest();
  }
});

it("keeps genuine cancellation attached after requester execution starts", async () => {
  const caller = new AbortController();
  const started = vi.fn();
  const dispatch = vi.fn(async (_method, _params, options) => {
    options?.onExecutionStarted?.();
    return await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason as Error), {
        once: true,
      });
    });
  });
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
  try {
    const delivery = runAnnounceAgentCall({
      agentParams: {},
      signal: caller.signal,
      onExecutionStarted: started,
      isExecutionAllowed: () => true,
    });
    expect(started).toHaveBeenCalledOnce();
    caller.abort(new Error("requester stopped"));
    await expect(delivery).rejects.toThrow("requester stopped");
  } finally {
    setSubagentAnnounceDeliveryDepsForTest();
  }
});

it.each([
  ["current", true],
  ["stale", false],
] as const)(
  "revalidates a %s continuation caller immediately before dispatch",
  async (_name, current) => {
    const route = Object.freeze({ channel: "discord", to: "channel:continuation" });
    const ambientAuthority = createAdmittedRunOperatorAuthority({
      profileId: "previous-requester",
      scopes: ["operator.read"],
      assertCurrent() {},
    });
    const input = reserveSessionControllerSource("agent:main:continuation", {
      target: captureSessionTarget({
        storeScope: "/synthetic/continuation-caller",
        sessionKey: "agent:main:continuation",
        incarnation: "continuation-session",
      }),
      reservationId: `subagent-settle:continuation:${current}`,
      policy: { mode: "followup" },
      continuationCaller: Object.freeze({
        deliveryRoute: route,
        run: async <T>(run: () => Promise<T>) => {
          if (!current) {
            throw new Error("continuation owner retired");
          }
          return run();
        },
      }),
    });
    const observedAuthority = vi.fn();
    const dispatch = vi.fn(async () => {
      observedAuthority(readOperatorToolGatewayAuthority()?.operatorRunAuthority);
      return { status: "ok" };
    });
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
    try {
      const delivery = runWithOperatorToolGatewayAuthority(
        {
          operatorRunAuthority: ambientAuthority,
          scopes: ambientAuthority.scopes,
          signal: new AbortController().signal,
        },
        () =>
          runAnnounceAgentCall({
            agentParams: {},
            controllerInput: input,
            isExecutionAllowed: () => true,
          }),
      );
      if (current) {
        await expect(delivery).resolves.toEqual({ status: "ok" });
        expect(observedAuthority).toHaveBeenCalledWith(undefined);
      } else {
        await expect(delivery).rejects.toThrow("continuation owner retired");
        expect(dispatch).not.toHaveBeenCalled();
      }
      expect(input.continuationCaller?.deliveryRoute).toBe(route);
    } finally {
      setSubagentAnnounceDeliveryDepsForTest();
      retireSessionControllerInput(input);
      await input.settlement.promise;
    }
  },
);

it.each(["commit", "failure", "revocation"] as const)(
  "waits for the dispatch receipt and preserves %s before Gateway effects",
  async (outcome) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failed = new Error("dispatch receipt unavailable");
    let current = true;
    const dispatch = vi.fn(async () => ({ status: "ok" }));
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
    try {
      const delivery = runAnnounceAgentCall({
        agentParams: {},
        isExecutionAllowed: () => current,
        onBeforeDispatch: async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "failure") {
            throw failed;
          }
        },
      });
      await entered.promise;
      expect(dispatch).not.toHaveBeenCalled();
      current = outcome !== "revocation";
      release.resolve();
      if (outcome === "commit") {
        await expect(delivery).resolves.toEqual({ status: "ok" });
        expect(dispatch).toHaveBeenCalledOnce();
      } else if (outcome === "failure") {
        await expect(delivery).rejects.toBe(failed);
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        await expect(delivery).rejects.toThrow("subagent source lifecycle changed");
        expect(dispatch).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      setSubagentAnnounceDeliveryDepsForTest();
    }
  },
);

describe("hasFailedSubagentNoOutputCompletion", () => {
  it.each([
    [
      "recorded no visible result",
      { ...failedChild, result: "(no output)", noVisibleResult: true },
      true,
    ],
    [
      "reworded placeholder",
      { ...failedChild, result: "(nothing to report)", noVisibleResult: true },
      true,
    ],
    ["real result resembling placeholder", { ...failedChild, result: "(no output)" }, false],
    [
      "successful child",
      { ...failedChild, status: "ok", result: "(no output)", noVisibleResult: true },
      false,
    ],
    [
      "non-subagent source",
      { ...failedChild, source: "image_generation", result: "(no output)", noVisibleResult: true },
      false,
    ],
  ] as const)("classifies %s from the recorded result fact", (_label, event, expected) => {
    expect(hasFailedSubagentNoOutputCompletion([event])).toBe(expected);
  });

  it("reports nothing for an absent or empty event list", () => {
    expect(hasFailedSubagentNoOutputCompletion(undefined)).toBe(false);
    expect(hasFailedSubagentNoOutputCompletion([])).toBe(false);
  });
});
