// Browser tests cover pw tools core.interactions.evaluate.abort plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

let page: { evaluate: ReturnType<typeof vi.fn>; url: ReturnType<typeof vi.fn> } | null = null;
let locator: { evaluate: ReturnType<typeof vi.fn> } | null = null;

const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const restoreRoleRefsForTarget = vi.fn(() => {});
const isBrowserObservedDialogBlockedError = vi.fn(
  (err: unknown) => err instanceof Error && err.name === "BrowserObservedDialogBlockedError",
);
const isPolicyDenyNavigationError = vi.fn(() => false);
const markObservedDialogsHandledRemotelyForPage = vi.fn(() => ({}));
const quarantineBlockedNavigationTarget = vi.fn(async () => {});
const quarantineBlockedNavigationTargetForError = vi.fn(async () => {});
const wasBrowserNavigationRequestBlockedBeforeDispatch = vi.fn(() => false);
const wasBrowserNavigationErrorQuarantined = vi.fn(() => false);
const withPageNavigationRequestGuard = vi.fn(
  async <T>({ action }: { action: () => Promise<T> }): Promise<T> => await action(),
);
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});

vi.mock("./pw-session.js", () => {
  return {
    assertPageNavigationCompletedSafely,
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    isBrowserObservedDialogBlockedError,
    isPolicyDenyNavigationError,
    markObservedDialogsHandledRemotelyForPage,
    quarantineBlockedNavigationTarget,
    quarantineBlockedNavigationTargetForError,
    refLocator,
    restoreRoleRefsForTarget,
    wasBrowserNavigationRequestBlockedBeforeDispatch,
    wasBrowserNavigationErrorQuarantined,
    withPageNavigationRequestGuard,
  };
});

const { evaluateViaPlaywright } = await import("./pw-tools-core.interactions.js");

function createPendingEval() {
  let evalCalled: (() => void) | undefined;
  const evalCalledPromise = new Promise<void>((resolve) => {
    evalCalled = resolve;
  });
  if (!evalCalled) {
    throw new Error("Expected evaluate callback to be initialized");
  }
  return {
    evalCalledPromise,
    resolveEvalCalled: evalCalled,
  };
}

describe("evaluateViaPlaywright (abort)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = null;
    locator = null;
  });

  it.each([
    { label: "page.evaluate", fn: "() => 1" },
    { label: "locator.evaluate", fn: "(el) => el.textContent", ref: "e1" },
  ])("rejects when aborted after $label starts", async ({ fn, ref }) => {
    const ctrl = new AbortController();
    const pending = createPendingEval();
    const pendingPromise = new Promise(() => {});

    page = {
      evaluate: vi.fn(() => {
        if (!ref) {
          pending.resolveEvalCalled();
        }
        return pendingPromise;
      }),
      url: vi.fn(() => "https://example.com/current"),
    };
    locator = {
      evaluate: vi.fn(() => {
        if (ref) {
          pending.resolveEvalCalled();
        }
        return pendingPromise;
      }),
    };

    const p = evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      fn,
      ref,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      signal: ctrl.signal,
    });

    await pending.evalCalledPromise;
    ctrl.abort(new Error("aborted by test"));

    await expect(p).rejects.toThrow("aborted by test");
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: undefined,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      reason: "evaluate aborted",
    });
  });

  it.each([
    { label: "page.evaluate", fn: "() => 1" },
    { label: "locator.evaluate", fn: "(el) => el.textContent", ref: "e1" },
  ])("installs the request guard before starting $label", async ({ fn, ref }) => {
    page = {
      evaluate: vi.fn(async () => "page result"),
      url: vi.fn(() => "https://example.com/current"),
    };
    locator = {
      evaluate: vi.fn(async () => "locator result"),
    };
    const evaluate = ref ? locator.evaluate : page.evaluate;
    withPageNavigationRequestGuard.mockImplementationOnce(
      async <T>({ action }: { action: () => Promise<T> }): Promise<T> => {
        expect(evaluate).not.toHaveBeenCalled();
        return await action();
      },
    );

    await evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      fn,
      ref,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    });

    expect(withPageNavigationRequestGuard).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect when evaluate is blocked by an observed dialog", async () => {
    const ctrl = new AbortController();
    const pending = createPendingEval();
    let resolveEval: (value: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveEval = resolve;
    });
    page = {
      evaluate: vi.fn(() => {
        pending.resolveEvalCalled();
        return pendingPromise;
      }),
      url: vi.fn(() => "https://example.com/current"),
    };

    const p = evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      fn: "() => alert('x')",
      signal: ctrl.signal,
    });

    await pending.evalCalledPromise;
    const err = new Error("blocked by dialog");
    err.name = "BrowserObservedDialogBlockedError";
    ctrl.abort(err);

    await expect(p).rejects.toThrow("blocked by dialog");
    expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
    resolveEval(true);
    await Promise.resolve();
    expect(markObservedDialogsHandledRemotelyForPage).toHaveBeenCalled();
  });
});
