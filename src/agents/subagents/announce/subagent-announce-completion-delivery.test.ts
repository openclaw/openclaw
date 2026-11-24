// Completion predicates read recorded facts, not rendered placeholder wording.
import { describe, expect, it, vi } from "vitest";
import {
  bindGatewayContextResolver,
  getGatewayContextLifetime,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
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

it("cancels an accepted private reply when its canonical Gateway closes", async () => {
  const owner = () => undefined;
  const wrapper = () => undefined;
  bindGatewayContextResolver(wrapper, owner);
  const release = createDeferredCore<unknown>();
  const accepted = vi.fn();
  let executionSignal: AbortSignal | undefined;
  setSubagentAnnounceDeliveryDepsForTest({
    dispatchGatewayMethodInProcess: async (_method, _params, options) => {
      executionSignal = options?.signal;
      options?.onAccepted?.({});
      return await release.promise;
    },
  });
  const pending = runAnnounceAgentCall({
    agentParams: {},
    privateCompletion: true,
    resolveGatewayContext: wrapper,
    onAccepted: accepted,
    isExecutionAllowed: () => true,
  });
  void pending.catch(() => {});
  try {
    expect(accepted).toHaveBeenCalledOnce();
    const shutdown = new Error("owning Gateway closed");
    getGatewayContextLifetime(owner).abort(shutdown);
    expect(executionSignal?.reason).toBe(shutdown);
    await expect(pending).rejects.toThrow("owning Gateway closed");
  } finally {
    release.resolve(undefined);
    await Promise.allSettled([pending]);
    setSubagentAnnounceDeliveryDepsForTest();
  }
});

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
