// Browser tests cover interaction policy cancellation and dialog interruption.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserObservedDialogBlockedError } from "./pw-session-contracts.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

const interactions = await import("./pw-tools-core.interactions.js");

type NavigationGuardCall = {
  action: (url: string) => Promise<unknown>;
  onPolicyCheckStarted?: (check: Promise<void>) => void;
  page: { url: () => string };
  signal?: AbortSignal;
};

function policyCheckWithSignal(
  policy: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    return policy;
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "aborted")),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    policy.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const strictNavigationOptions = () =>
  ({
    cdpUrl: "http://127.0.0.1:18792",
    targetId: "tab-1",
    ssrfPolicy: { allowPrivateNetwork: false },
  }) as const;

function installInteractionPage(
  page: Record<string, unknown>,
  locator: Record<string, unknown>,
): void {
  setPwToolsCoreCurrentPage(page);
  setPwToolsCoreCurrentRefLocator(locator);
}

function mockNavigationGuardOnce(
  implementation: (args: NavigationGuardCall) => Promise<unknown>,
): void {
  getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
    implementation,
  );
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  await run().finally(() => vi.useRealTimers());
}

installPwToolsCoreTestHooks();

describe("pw-tools-core interaction policy cancellation", () => {
  beforeEach(() => {
    getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockImplementation(
      () => false,
    );
  });

  it("does not leave caller cancellation pending behind a never-settling policy check", async () => {
    await withFakeTimers(async () => {
      const ctrl = new AbortController();
      const policyStarted = createDeferred<void>();
      const policy = createDeferred<void>();
      let policySignal: AbortSignal | undefined;
      installInteractionPage({ url: vi.fn(() => "about:blank") }, { hover: vi.fn(async () => {}) });
      mockNavigationGuardOnce(async ({ action, onPolicyCheckStarted, page, signal }) => {
        policySignal = signal;
        const actionTask = action(page.url());
        const policyCheck = policyCheckWithSignal(policy.promise, signal);
        onPolicyCheckStarted?.(policyCheck);
        policyStarted.resolve();
        await actionTask;
        await policyCheck;
      });

      const task = interactions.hoverViaPlaywright({
        ...strictNavigationOptions(),
        ref: "1",
        signal: ctrl.signal,
      });
      const settled = task.then(
        () => true,
        () => true,
      );
      await policyStarted.promise;
      await vi.advanceTimersByTimeAsync(250);

      try {
        const observeSettlement = async (): Promise<boolean> => {
          const observed = Promise.race([
            settled,
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 1);
            }),
          ]);
          await vi.advanceTimersByTimeAsync(1);
          return await observed;
        };

        expect(await observeSettlement()).toBe(false);
        ctrl.abort(new Error("aborted while policy remained pending"));
        expect(policySignal?.aborted).toBe(true);
        expect(await observeSettlement()).toBe(true);
      } finally {
        policy.resolve();
        await settled;
      }
    });
  });

  it("returns caller abort after an in-flight policy check observes cancellation", async () => {
    const ctrl = new AbortController();
    const hover = createDeferred<void>();
    const policy = createDeferred<void>();
    const started = createDeferred<void>();
    const abortError = new Error("aborted while policy pending");
    let policySignal: AbortSignal | undefined;
    installInteractionPage(
      { url: vi.fn(() => "about:blank") },
      {
        hover: vi.fn(() => hover.promise),
      },
    );
    mockNavigationGuardOnce(async ({ action, onPolicyCheckStarted, page, signal }) => {
      policySignal = signal;
      const actionTask = action(page.url());
      onPolicyCheckStarted?.(policyCheckWithSignal(policy.promise, signal));
      started.resolve();
      await policyCheckWithSignal(policy.promise, signal);
      return await actionTask;
    });

    const task = interactions.hoverViaPlaywright({
      ...strictNavigationOptions(),
      ref: "1",
      signal: ctrl.signal,
    });
    await started.promise;
    ctrl.abort(abortError);

    await expect(task).rejects.toBe(abortError);
    expect(policySignal?.aborted).toBe(true);
    hover.resolve();
  });

  it("keeps policy work live when an observed dialog interrupts the interaction", async () => {
    await withFakeTimers(async () => {
      const ctrl = new AbortController();
      const dialogError = new BrowserObservedDialogBlockedError({
        dialogs: { pending: [], recent: [] },
      });
      const policyStarted = createDeferred<void>();
      const policy = createDeferred<void>();
      const hover = createDeferred<void>();
      let policySignal: AbortSignal | undefined;
      let guardSettled = false;
      installInteractionPage(
        { url: vi.fn(() => "about:blank") },
        { hover: vi.fn(() => hover.promise) },
      );
      getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
      getPwToolsCoreSessionMocks().isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
      mockNavigationGuardOnce(async ({ action, onPolicyCheckStarted, page, signal }) => {
        policySignal = signal;
        const actionTask = action(page.url());
        onPolicyCheckStarted?.(policy.promise);
        policyStarted.resolve();
        try {
          await policy.promise;
          await actionTask;
        } finally {
          guardSettled = true;
        }
      });

      const task = interactions.hoverViaPlaywright({
        ...strictNavigationOptions(),
        ref: "1",
        signal: ctrl.signal,
      });
      await policyStarted.promise;
      ctrl.abort(dialogError);
      policy.resolve();

      await expect(task).rejects.toBe(dialogError);
      expect(policySignal?.aborted).toBe(false);
      expect(guardSettled).toBe(false);

      hover.resolve();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      expect(guardSettled).toBe(true);
    });
  });
});
