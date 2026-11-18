import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserObservedDialogBlockedError } from "./pw-session-contracts.js";
import { withFakeTimers } from "./pw-tools-core.guard-test-support.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

// Load after the test harness registers the session module mocks.
const interactions = await import("./pw-tools-core.interactions.actions.js");

type NavigationGuardCall = {
  action: (url: string) => Promise<unknown>;
  onPolicyCheckStarted?: (check: Promise<void>) => void;
  page: { url: () => string };
  signal?: AbortSignal;
};

async function policyCheckWithSignal(
  policy: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    return policy;
  }
  signal.throwIfAborted();
  const aborted = createDeferred<void>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([policy, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function interactionFixture({ hover = async () => {}, actionFirst = false, dialog = false } = {}) {
  const ctrl = new AbortController();
  const started = createDeferred<void>();
  const policy = createDeferred<void>();
  let policySignal: AbortSignal | undefined;
  let guardSettled = false;
  setPwToolsCoreCurrentPage({ url: vi.fn(() => "about:blank") });
  setPwToolsCoreCurrentRefLocator({ hover: vi.fn(hover) });
  getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
    async ({ action, onPolicyCheckStarted, page, signal }: NavigationGuardCall) => {
      policySignal = signal;
      const actionTask = action(page.url());
      const check = dialog ? policy.promise : policyCheckWithSignal(policy.promise, signal);
      onPolicyCheckStarted?.(check);
      started.resolve();
      try {
        if (actionFirst) {
          await actionTask;
        }
        await check;
        if (!actionFirst) {
          await actionTask;
        }
      } finally {
        guardSettled = true;
      }
    },
  );
  return {
    ctrl,
    started,
    policy,
    signal: () => policySignal,
    settled: () => guardSettled,
    run: () =>
      interactions.hoverViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
        signal: ctrl.signal,
      }),
  };
}

installPwToolsCoreTestHooks();

describe("pw-tools-core interaction policy cancellation", () => {
  beforeEach(() => {
    getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockImplementation(
      () => false,
    );
  });

  it.each([true, false])("cancels pending policy work (action finished=%s)", async (finished) => {
    await withFakeTimers(async () => {
      const hover = createDeferred<void>();
      const fixture = interactionFixture({
        actionFirst: finished,
        hover: finished ? async () => {} : () => hover.promise,
      });
      const { ctrl, started, policy } = fixture;
      const outcomes: unknown[] = [];
      const completion = fixture.run().then(
        (value) => {
          outcomes.push(value);
        },
        (error: unknown) => {
          outcomes.push(error);
        },
      );
      const abortError = new Error("aborted while policy pending");
      try {
        await started.promise;
        await vi.advanceTimersByTimeAsync(250);
        expect(outcomes).toEqual([]);
        ctrl.abort(abortError);
        expect(fixture.signal()?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(outcomes).toEqual([abortError]);
      } finally {
        policy.resolve();
        hover.resolve();
        await completion;
      }
    });
  });

  it("keeps policy work live when an observed dialog interrupts the interaction", async () => {
    await withFakeTimers(async () => {
      const dialogError = new BrowserObservedDialogBlockedError({
        dialogs: { pending: [], recent: [] },
      });
      const hover = createDeferred<void>();
      const fixture = interactionFixture({ hover: () => hover.promise, dialog: true });
      const { ctrl, started, policy } = fixture;
      getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
      getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
      const task = fixture.run();
      await started.promise;
      ctrl.abort(dialogError);
      policy.resolve();
      await expect(task).rejects.toBe(dialogError);
      expect(fixture.signal()?.aborted).toBe(false);
      expect(fixture.settled()).toBe(false);
      hover.resolve();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      expect(fixture.settled()).toBe(true);
    });
  });
});
