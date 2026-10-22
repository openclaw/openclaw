import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserObservedDialogBlockedError } from "./pw-session-contracts.js";
import {
  heldAction,
  withFakeTimers,
  type NavigationGuardCall,
} from "./pw-tools-core.guard-test-support.js";

const pageState = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  locator: null as Record<string, unknown> | null,
}));

const session = await vi.hoisted(async () => {
  const { createGuardSession } = await import("./pw-tools-core.guard-test-support.js");
  return {
    ...createGuardSession(
      () => {
        if (!pageState.page) {
          throw new Error("missing page");
        }
        return pageState.page;
      },
      () => {
        if (!pageState.locator) {
          throw new Error("missing locator");
        }
        return pageState.locator;
      },
    ),
    closeBlockedNavigationTarget: vi.fn(async () => {}),
    gotoPageWithNavigationGuard: vi.fn(async () => null),
    storeRoleRefsForTarget: vi.fn(() => {}),
  };
});

vi.mock("./pw-session.js", () => session);

const pw = await import("./pw-tools-core.interactions.actions.js");
const { waitForViaPlaywright } = await import("./pw-tools-core.interactions.content.js");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };
const strict = { ...target, ssrfPolicy: { allowPrivateNetwork: false } };
const proxied = { ...strict, browserProxyMode: "explicit-browser-proxy" } as const;

function trackSettlement(task: Promise<unknown>) {
  const settled = vi.fn();
  void task.finally(settled).catch(() => {});
  return settled;
}

function pendingHover(url = "about:blank") {
  const ctrl = new AbortController();
  const hover = heldAction();
  install({ url: () => url }, { hover: hover.run });
  return { ctrl, hover };
}

function startHover(ctrl?: AbortController) {
  return pw.hoverViaPlaywright({ ...strict, ref: "1", signal: ctrl?.signal });
}

function install(
  page: Record<string, unknown> = { url: () => "https://example.com" },
  locator: Record<string, unknown> = {},
): void {
  const mainFrame = {};
  page.mainFrame ??= vi.fn(() => mainFrame);
  page.on ??= vi.fn();
  page.off ??= vi.fn();
  pageState.page = page;
  pageState.locator = locator;
}

function guardOnce(implementation: (args: NavigationGuardCall) => Promise<unknown>): void {
  session.withPageNavigationRequestGuard.mockImplementationOnce(implementation);
}

function trackGuardSettlement() {
  const settled = vi.fn();
  guardOnce(async ({ action, page }) => {
    try {
      return await action(page.url());
    } finally {
      settled();
    }
  });
  return settled;
}

function policyFailure(message = "browser navigation blocked by policy") {
  return Object.assign(new Error(message), { name: "SsrFBlockedError" });
}

function expectQuarantined() {
  expect(session.quarantineBlockedNavigationTarget).toHaveBeenCalledWith({
    ...target,
    page: pageState.page,
  });
}

function documentPage<T>(waitForFunction: T, url = "https://example.com") {
  const documentHandle = { dispose: vi.fn(async () => {}) };
  const page = {
    url: vi.fn(() => url),
    evaluateHandle: vi.fn(async () => documentHandle),
    waitForFunction,
  };
  install(page);
  return { page, documentHandle };
}
type WaitState = { document: unknown };
type WaitPredicate = (state: WaitState) => boolean;
function pendingEvaluation(result: Promise<unknown> = new Promise(() => {})) {
  const ctrl = new AbortController();
  const entered = Promise.withResolvers<void>();
  install({
    url: () => "https://example.com/current",
    evaluate: () => {
      entered.resolve();
      return result;
    },
  });
  return { ctrl, entered: entered.promise };
}
function preservePolicyDenial(blocked: Error) {
  session.isPolicyDenyNavigationError.mockImplementation((err: unknown) => err === blocked);
  session.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockImplementation(
    (err: unknown) => err === blocked,
  );
}
function wait(signal?: AbortSignal, fn = "() => true") {
  return waitForViaPlaywright({ ...strict, fn, signal });
}

describe("pw-tools-core browser SSRF guards", () => {
  beforeEach(() => {
    pageState.page = null;
    pageState.locator = null;
    session.isBrowserObservedDialogBlockedError.mockReturnValue(false);
    session.isPolicyDenyNavigationError.mockReturnValue(false);
    session.wasBrowserNavigationSourcePreservedAfterPolicyDenial.mockReturnValue(false);
    for (const fn of Object.values(session)) {
      fn.mockClear();
    }
  });

  it.each(["() => true", "async () => true"])(
    "guards %s wait predicates and preserves proxy policy",
    async (fn) => {
      let currentUrl = "https://example.com";
      const order: string[] = [];
      guardOnce(async ({ action, page }) => {
        order.push("guard");
        return await action(page.url());
      });
      const documentHandle = { dispose: vi.fn(async () => {}) };
      const waitForFunction = vi.fn(async (predicate: WaitPredicate, state: WaitState) => {
        order.push("predicate");
        const browserState = { ...state, document: globalThis.document };
        expect(predicate(browserState)).toBe(!fn.startsWith("async"));
        if (fn.startsWith("async")) {
          await Promise.resolve();
          expect(predicate(browserState)).toBe(true);
        }
        currentUrl = "https://93.184.216.34/target";
      });
      install({
        url: () => currentUrl,
        evaluateHandle: vi.fn(async () => documentHandle),
        waitForTimeout: vi.fn(async () => {
          order.push("passive");
        }),
        waitForFunction,
      });
      await waitForViaPlaywright({ ...proxied, timeMs: 1, fn });
      expect(waitForFunction).toHaveBeenCalledOnce();
      expect(waitForFunction).toHaveBeenCalledWith(
        expect.any(Function),
        { document: documentHandle },
        { timeout: expect.any(Number) },
      );
      expect(order).toEqual(["guard", "passive", "predicate"]);
      expect(session.withPageNavigationRequestGuard).toHaveBeenCalledWith({
        action: expect.any(Function),
        onPolicyCheckStarted: expect.any(Function),
        onPolicyDenied: expect.any(Function),
        page: pageState.page,
        ssrfPolicy: { allowPrivateNetwork: false },
        browserProxyMode: "explicit-browser-proxy",
      });
      expect(session.assertPageNavigationCompletedSafely).toHaveBeenLastCalledWith({
        ...proxied,
        page: pageState.page,
        response: null,
      });
      expect(session.closeBlockedNavigationTarget).not.toHaveBeenCalled();
      expect(documentHandle.dispose).toHaveBeenCalledOnce();
    },
  );

  it("does not recreate a wait predicate in a replacement document", async () => {
    const { documentHandle } = documentPage(
      vi.fn(async (predicate: WaitPredicate, state: WaitState) =>
        predicate({ ...state, document: {} }),
      ),
      "https://example.com/next",
    );

    await expect(wait(undefined, "() => document.cookie")).rejects.toThrow(
      "Wait predicate document changed",
    );

    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it("does not start a predicate after aborting an earlier wait condition", async () => {
    const ctrl = new AbortController();
    const dialogError = new BrowserObservedDialogBlockedError({
      dialogs: { pending: [], recent: [] },
    });
    session.isBrowserObservedDialogBlockedError.mockReturnValueOnce(true);
    const waitForFunction = vi.fn(async () => {});
    install({
      url: vi.fn(() => "https://example.com"),
      waitForTimeout: vi.fn(async () => {
        ctrl.abort(dialogError);
      }),
      waitForFunction,
    });

    await expect(
      waitForViaPlaywright({
        ...strict,
        timeMs: 1,
        fn: "() => true",
        signal: ctrl.signal,
      }),
    ).rejects.toBe(dialogError);
    await Promise.resolve();
    expect(waitForFunction).not.toHaveBeenCalled();
    expect(session.markObservedDialogsHandledRemotelyForPage).toHaveBeenCalledWith(
      pageState.page,
      dialogError.browserState.dialogs.pending,
    );
  });

  it("does not start a predicate when document capture finishes after abort", async () => {
    const ctrl = new AbortController();
    const waitForFunction = vi.fn(async () => {});
    const { page, documentHandle } = documentPage(waitForFunction);
    page.evaluateHandle.mockImplementation(async () => {
      ctrl.abort(new Error("aborted during document capture"));
      return documentHandle;
    });

    await expect(wait(ctrl.signal)).rejects.toThrow("aborted during document capture");

    expect(waitForFunction).not.toHaveBeenCalled();
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });

  it.each(["observed denial", "pending denial", "pending allow"])(
    "joins %s before returning cancellation",
    async (mode) => {
      const observed = mode === "observed denial";
      const denied = mode !== "pending allow";
      const { ctrl, hover } = pendingHover();
      const policy = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const blocked = policyFailure();
      let guardSettled = false;
      if (denied) {
        preservePolicyDenial(blocked);
      }
      guardOnce(async ({ action, onPolicyCheckStarted, onPolicyDenied, page }) => {
        const actionTask = action(page.url());
        if (observed) {
          onPolicyDenied?.({ state: "detected", error: blocked });
        } else {
          onPolicyCheckStarted?.(policy.promise);
        }
        started.resolve();
        try {
          await policy.promise;
          if (observed) {
            onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: true });
          }
        } catch (err) {
          onPolicyDenied?.({ state: "detected", error: err });
          onPolicyDenied?.({ state: "handled", error: err, sourcePreserved: true });
        }
        try {
          const result = await actionTask;
          if (denied) {
            throw blocked;
          }
          return result;
        } finally {
          guardSettled = true;
        }
      });
      const task = startHover(ctrl);
      await started.promise;
      ctrl.abort(new Error("aborted while policy pending"));
      const settled = trackSettlement(task);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      if (denied && !observed) {
        policy.reject(blocked);
      } else {
        policy.resolve();
      }
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(guardSettled).toBe(false);
      hover.resolve();
      if (denied) {
        await expect(task).rejects.toBe(blocked);
      } else {
        await expect(task).rejects.toThrow("aborted while policy pending");
      }
      await vi.waitFor(() => expect(guardSettled).toBe(true));
    },
  );

  it("quarantines immediately when a preserved denied source later becomes unsafe", async () => {
    const { ctrl, hover } = pendingHover();
    const unsafeReported = Promise.withResolvers<void>();
    const detected = Promise.withResolvers<void>();
    const blocked = policyFailure();
    preservePolicyDenial(blocked);
    guardOnce(async ({ action, onPolicyDenied, page }) => {
      const actionTask = action(page.url());
      onPolicyDenied?.({ state: "detected", error: blocked });
      detected.resolve();
      onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: true });
      await unsafeReported.promise;
      onPolicyDenied?.({ state: "handled", error: blocked, sourcePreserved: false });
      await actionTask;
      throw blocked;
    });

    const task = startHover(ctrl);
    await detected.promise;
    ctrl.abort(new Error("aborted after policy denial"));
    unsafeReported.resolve();

    await vi.waitFor(expectQuarantined);
    hover.resolve();
    await expect(task).rejects.toBe(blocked);
  });

  it("keeps the request guard for the full grace after an early safe post-check", async () => {
    await withFakeTimers(async () => {
      let currentUrl = "https://example.com";
      install(
        { url: () => currentUrl },
        {
          hover: vi.fn(async () => {
            currentUrl = "https://example.org";
          }),
        },
      );
      const settled = trackGuardSettlement();
      const task = startHover();
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(settled).toHaveBeenCalledOnce();
    });
  });

  it("quarantines a late unpreserved policy failure before returning cancellation", async () => {
    const { ctrl, hover } = pendingHover("https://example.com");
    const blocked = policyFailure("late browser navigation blocked by policy");
    session.isPolicyDenyNavigationError.mockImplementationOnce(
      (err: unknown) => err instanceof Error && err.name === "SsrFBlockedError",
    );
    guardOnce(async ({ action, page }) => {
      await action(page.url());
      throw blocked;
    });

    const task = startHover(ctrl);
    await hover.started;
    ctrl.abort(new Error("aborted by test"));
    hover.resolve();
    await expect(task).rejects.toBe(blocked);
    await vi.waitFor(expectQuarantined);
  });

  it("preserves SSRF policy when aborting a pending click", async () => {
    const ctrl = new AbortController();
    const click = heldAction();
    let nativeSignal: AbortSignal | undefined;
    install(undefined, {
      click: vi.fn((options: { signal?: AbortSignal }) => {
        nativeSignal = options.signal;
        return click.run();
      }),
    });

    const task = pw.clickViaPlaywright({
      ...target,
      ref: "1",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    await click.started;
    ctrl.abort(new Error("aborted by test"));
    expect(nativeSignal?.aborted).toBe(true);
    click.reject(
      Object.assign(new Error("cancelled", { cause: nativeSignal?.reason }), {
        name: "AbortError",
      }),
    );

    await expect(task).rejects.toThrow("aborted by test");
    expect(session.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    expect(session.withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    );
  });

  it.each([false, true])("stops multi-step typing after abort (slowly=%s)", async (slowly) => {
    const ctrl = new AbortController();
    const firstStep = heldAction();
    const click = vi.fn(async () => {});
    const fill = vi.fn(async () => {});
    const type = vi.fn(async () => {});
    const press = vi.fn(async () => {});
    const locator = { click, fill, type, press };
    locator[slowly ? "click" : "fill"].mockImplementation(firstStep.run);
    install(undefined, locator);
    const settled = trackGuardSettlement();

    const task = pw.typeViaPlaywright({
      ...strict,
      ref: "1",
      text: "value",
      submit: true,
      slowly,
      signal: ctrl.signal,
    });

    await firstStep.started;
    ctrl.abort(new Error("aborted by test"));
    expect(settled).not.toHaveBeenCalled();
    firstStep.resolve();
    await expect(task).rejects.toThrow("aborted by test");
    expect(settled).toHaveBeenCalledOnce();
    expect(type).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it("stops form filling when the first field's request guard denies navigation", async () => {
    const fill = vi.fn(async () => {});
    const blocked = policyFailure("blocked field navigation");
    install(undefined, { fill });
    guardOnce(async ({ action, page }) => {
      await action(page.url());
      throw blocked;
    });

    await expect(
      pw.fillFormViaPlaywright({
        ...strict,
        fields: [
          { ref: "1", type: "text", value: "first" },
          { ref: "2", type: "text", value: "second" },
        ],
      }),
    ).rejects.toThrow("blocked field navigation");

    expect(fill).toHaveBeenCalledOnce();
    expect(session.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
  });
  it("disconnects a pending page evaluation on caller cancellation", async () => {
    const { ctrl, entered } = pendingEvaluation();
    const task = pw.evaluateViaPlaywright({
      ...strict,
      fn: "() => 1",
      signal: ctrl.signal,
    });
    await entered;
    ctrl.abort(new Error("aborted by test"));
    await expect(task).rejects.toThrow("aborted by test");
    expect(session.forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      ...strict,
      page: pageState.page,
    });
  });

  it("reconciles an observed dialog after evaluation settles without disconnecting", async () => {
    const evaluation = Promise.withResolvers<boolean>();
    const { ctrl, entered } = pendingEvaluation(evaluation.promise);
    const task = pw.evaluateViaPlaywright({
      ...target,
      fn: "() => alert('x')",
      signal: ctrl.signal,
    });
    await entered;
    const error = new BrowserObservedDialogBlockedError({
      dialogs: {
        pending: [{ id: "d1", type: "alert", message: "x", openedAt: "2026-09-08T00:00:00Z" }],
        recent: [],
      },
    });
    session.isBrowserObservedDialogBlockedError.mockImplementation(
      (err) => err instanceof BrowserObservedDialogBlockedError,
    );
    ctrl.abort(error);
    await expect(task).rejects.toBe(error);
    expect(session.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    evaluation.resolve(true);
    await vi.waitFor(() =>
      expect(session.markObservedDialogsHandledRemotelyForPage).toHaveBeenCalledWith(
        pageState.page,
        error.browserState.dialogs.pending,
      ),
    );
  });
});
