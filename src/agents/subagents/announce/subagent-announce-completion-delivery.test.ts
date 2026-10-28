import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../../../gateway/operator-tool-gateway-authority.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { hasFailedSubagentNoOutputCompletion } from "../../internal-event-contract.js";
import { runAnnounceAgentCall } from "./subagent-announce-completion-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import type { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";

afterEach(() => setSubagentAnnounceDeliveryDepsForTest());
const dispatch = vi.fn<typeof dispatchGatewayMethodInProcess>();
beforeEach(() => {
  dispatch.mockReset().mockResolvedValue({ status: "ok" });
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
});
const announce = (overrides: Partial<Parameters<typeof runAnnounceAgentCall>[0]> = {}) =>
  runAnnounceAgentCall({ agentParams: {}, isExecutionAllowed: () => true, ...overrides });

it("does not dispatch a private handoff after its caller has already cancelled", async () => {
  const caller = new AbortController();
  caller.abort(new Error("requester stopped"));
  await expect(announce({ privateCompletion: true, signal: caller.signal })).rejects.toThrow(
    "requester stopped",
  );
  expect(dispatch).not.toHaveBeenCalled();
});

it("keeps genuine cancellation attached after requester execution starts", async () => {
  const caller = new AbortController();
  const started = vi.fn();
  dispatch.mockImplementation(async (_method, _params, options) => {
    options?.onExecutionStarted?.();
    return await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason as Error), {
        once: true,
      });
    });
  });
  const delivery = announce({ signal: caller.signal, onExecutionStarted: started });
  expect(started).toHaveBeenCalledOnce();
  caller.abort(new Error("requester stopped"));
  await expect(delivery).rejects.toThrow("requester stopped");
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
    dispatch.mockImplementation(async () => {
      expect(readOperatorToolGatewayAuthority()?.operatorRunAuthority).toBeUndefined();
      return { status: "ok" };
    });
    try {
      const delivery = runWithOperatorToolGatewayAuthority(
        {
          operatorRunAuthority: ambientAuthority,
          scopes: ambientAuthority.scopes,
          signal: new AbortController().signal,
        },
        () => announce({ controllerInput: input }),
      );
      if (current) {
        await expect(delivery).resolves.toEqual({ status: "ok" });
      } else {
        await expect(delivery).rejects.toThrow("continuation owner retired");
        expect(dispatch).not.toHaveBeenCalled();
      }
      expect(input.continuationCaller?.deliveryRoute).toBe(route);
    } finally {
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
    try {
      const delivery = announce({
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
      } else if (outcome === "failure") {
        await expect(delivery).rejects.toBe(failed);
      } else {
        await expect(delivery).rejects.toThrow("subagent source lifecycle changed");
      }
      expect(dispatch).toHaveBeenCalledTimes(outcome === "commit" ? 1 : 0);
    } finally {
      release.resolve();
    }
  },
);

it("rechecks a retained caller after the dispatch receipt await", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let current = true;
  const delivery = announce({
    agentToolCaller: {
      agentId: "main",
      sessionKey: "agent:main:requester",
      assertCurrent: () => {
        if (!current) {
          throw new Error("original singleton changed");
        }
      },
    },
    onBeforeDispatch: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    await entered.promise;
    current = false;
    release.resolve();
    await expect(delivery).rejects.toThrow("subagent source lifecycle changed");
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
});

it.each(["current", "commit", "accepted owner"] as const)(
  "rechecks a retained caller at %s before a Gateway effect",
  async (boundary) => {
    let current = true;
    let effects = 0;
    dispatch.mockImplementation(async (_method, _params, options) => {
      current = boundary !== "commit";
      options?.sessionMutationCommitGuard?.();
      // Admission hands the input to its fresh owner. Retiring the old caller
      // must not poison that accepted run's independent execution authority.
      if (boundary === "accepted owner") {
        current = false;
      }
      options?.onExecutionStarted?.();
      effects += 1;
      return { status: "ok" };
    });
    const delivery = announce({
      settleWakeSourceSessionKeys: ["agent:main:subagent:only"],
      agentToolCaller: {
        agentId: "main",
        sessionKey: "agent:main:requester",
        assertCurrent: () => {
          if (!current) {
            throw new Error("original singleton changed");
          }
        },
      },
    });
    if (boundary === "commit") {
      await expect(delivery).rejects.toThrow("subagent source lifecycle changed");
    } else {
      await expect(delivery).resolves.toEqual({ status: "ok" });
    }
    expect(effects).toBe(boundary === "commit" ? 0 : 1);
  },
);

it.each([
  ["absent", { noVisibleResult: true }, true],
  ["reworded", { noVisibleResult: true, result: "(nothing to report)" }, true],
  ["visible placeholder", {}, false],
  ["success", { noVisibleResult: true, status: "ok" }, false],
  ["other source", { noVisibleResult: true, source: "image_generation" }, false],
] as const)("classifies %s completion from the recorded fact", (_label, overrides, expected) => {
  const event = {
    type: "task_completion",
    source: "subagent",
    status: "error",
    result: "(no output)",
    ...overrides,
  } as const;
  expect(hasFailedSubagentNoOutputCompletion([event])).toBe(expected);
});

it("reports nothing for an absent or empty event list", () => {
  expect(hasFailedSubagentNoOutputCompletion(undefined)).toBe(false);
  expect(hasFailedSubagentNoOutputCompletion([])).toBe(false);
});

it.each(["deadline", "admission", "execution"] as const)(
  "publishes a materialized %s abort reason with unchanged failure identity",
  async (trigger) => {
    vi.useFakeTimers();
    const prepareStackTrace = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    const formatted = new Set<Error>();
    Error.prepareStackTrace = (error) => {
      formatted.add(error);
      return `${error.name}: ${error.message}`;
    };
    let current = true;
    let signal: AbortSignal | undefined;
    let formattedAtAbort = false;
    dispatch.mockImplementation(async (_method, _params, options) => {
      signal = options?.signal;
      signal?.addEventListener("abort", () => {
        formattedAtAbort = formatted.has(signal?.reason);
      });
      if (trigger === "deadline") {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason as Error), { once: true });
        });
      }
      current = false;
      if (trigger === "admission") {
        options?.sessionMutationCommitGuard?.();
      } else {
        options?.onExecutionStarted?.();
      }
      return undefined;
    });
    try {
      const result = announce({
        timeoutMs: 10,
        isExecutionAllowed: () => current,
        isSourceSessionAdmissionAllowed: () => current,
      }).catch((error: unknown) => error);
      if (trigger === "deadline") {
        await vi.advanceTimersByTimeAsync(10);
      }
      const failure = await result;
      expect(formattedAtAbort).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(failure).toBe(signal?.reason);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        trigger === "deadline"
          ? "gateway request timeout for agent"
          : "subagent source lifecycle changed before completion delivery",
      );
    } finally {
      if (prepareStackTrace) {
        Object.defineProperty(Error, "prepareStackTrace", prepareStackTrace);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
      vi.useRealTimers();
    }
  },
);
