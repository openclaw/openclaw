import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const navigationGuardMocks = getPwToolsCoreNavigationGuardMocks();
const sessionMocks = getPwToolsCoreSessionMocks();
const mod = await import("./pw-tools-core.js");

type EvaluateArg = unknown;

function evaluateMockReturning(view: { x: number; y: number; width?: number; height?: number }) {
  // Caller reads { x, y, width, height } in one evaluate; default to a normal
  // desktop viewport so refs near the top stay in-viewport unless a test puts
  // them out of range explicitly.
  const result = { width: 1280, height: 720, ...view };
  return vi.fn(async (arg: EvaluateArg) => {
    if (typeof arg === "function") {
      return result;
    }
    return true;
  });
}

type FrameListener = (frame: { url: () => string }) => void;

function createNavigationAwarePage(initialUrl = "https://safe.example/start") {
  let currentUrl = initialUrl;
  const listeners = new Set<FrameListener>();
  const frame = { url: vi.fn(() => currentUrl) };
  return {
    listeners,
    navigate(nextUrl: string) {
      currentUrl = nextUrl;
      for (const listener of listeners) {
        listener(frame);
      }
    },
    page: {
      url: vi.fn(() => currentUrl),
      on: vi.fn((event: string, listener: FrameListener) => {
        if (event === "framenavigated") {
          listeners.add(listener);
        }
      }),
      off: vi.fn((event: string, listener: FrameListener) => {
        if (event === "framenavigated") {
          listeners.delete(listener);
        }
      }),
    },
  };
}

function createBlockedNavigationError() {
  const error = new Error("Navigation blocked by SSRF policy");
  error.name = "SsrFBlockedError";
  return error;
}

describe("screenshotWithLabelsViaPlaywright (viewport)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls page.screenshot without fullPage and returns annotations", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 100 });
    const screenshot = vi.fn(async () => Buffer.from("PNG"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot, url: () => "https://example.com" });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 10, y: 200, width: 50, height: 20 }),
    });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button", name: "Submit" } },
      type: "png",
    });

    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "png" }));
    expect(screenshot).not.toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]).toMatchObject({
      ref: "e1",
      number: 1,
      role: "button",
      name: "Submit",
    });
    // viewport-mode box = doc(box.x + scroll.x, box.y + scroll.y) - scroll = bbox
    expect(result.annotations[0]?.box).toEqual({ x: 10, y: 200, width: 50, height: 20 });
    expect(result.skipped).toBe(0);
  });

  it("runs the clear script even when screenshot throws", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    const screenshot = vi.fn(async () => {
      throw new Error("boom");
    });
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 0, y: 0, width: 1, height: 1 }),
    });

    await expect(
      mod.screenshotWithLabelsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        refs: { e1: { role: "button" } },
      }),
    ).rejects.toThrow(/boom/);

    // The clear script must have run (string evaluate calls include the overlay attr)
    const clearCalls = evaluate.mock.calls.filter(
      ([arg]) => typeof arg === "string" && arg.includes("data-openclaw-labels"),
    );
    // inject + clear = at least 2 string evaluations
    expect(clearCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the navigation guard active through overlay cleanup", async () => {
    vi.useFakeTimers();
    try {
      const navigation = createNavigationAwarePage();
      let evaluateCall = 0;
      const evaluate = vi.fn(async () => {
        evaluateCall += 1;
        if (evaluateCall === 1) {
          return { x: 0, y: 0, width: 1280, height: 720 };
        }
        if (evaluateCall === 3) {
          navigation.navigate("http://169.254.169.254/latest/meta-data");
        }
        return undefined;
      });
      const screenshot = vi.fn(async () => Buffer.from("PNG"));
      const page = { ...navigation.page, evaluate, screenshot };
      const blockedError = createBlockedNavigationError();
      sessionMocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(blockedError);
      setPwToolsCoreCurrentPage(page);
      setPwToolsCoreCurrentRefLocator({
        boundingBox: async () => ({ x: 10, y: 20, width: 50, height: 20 }),
      });

      const task = mod.screenshotWithLabelsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        refs: { e1: { role: "button" } },
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toBe(blockedError);

      await vi.advanceTimersByTimeAsync(0);
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(navigation.listeners.size).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(sessionMocks.quarantineBlockedNavigationTargetForError).toHaveBeenCalledWith(
        expect.objectContaining({ error: blockedError, page, targetId: "T1" }),
      );
      expect(navigation.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts off-viewport refs as skipped but still surfaces them in annotations", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0, width: 1280, height: 720 });
    const screenshot = vi.fn(async () => Buffer.from("PNG"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    // bbox is far below the viewport (y: 5000): not drawn, but still reported
    // so callers keep the position and a non-zero skipped count.
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 0, y: 5000, width: 50, height: 20 }),
    });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" } },
    });

    expect(result.skipped).toBe(1);
    expect(result.labels).toBe(0);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.ref).toBe("e1");
  });
});

describe("snapshotRoleWithLabelsViaPlaywright", () => {
  it("captures role refs and labels under one navigation guard", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = evaluateMockReturning({ x: 0, y: 0 });
      const screenshot = vi.fn(async () => Buffer.from("PNG"));
      const ariaSnapshot = vi.fn(async () => '- button "Submit"');
      const page = {
        evaluate,
        screenshot,
        locator: vi.fn(() => ({ ariaSnapshot })),
        url: vi.fn(() => "https://safe.example/start"),
      };
      setPwToolsCoreCurrentPage(page);
      setPwToolsCoreCurrentRefLocator({
        boundingBox: async () => ({ x: 10, y: 20, width: 50, height: 20 }),
      });

      const task = mod.snapshotRoleWithLabelsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      await vi.advanceTimersByTimeAsync(250);
      const result = await task;

      expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledOnce();
      expect(ariaSnapshot).toHaveBeenCalledOnce();
      expect(screenshot).toHaveBeenCalledOnce();
      expect(result.snapshot).toContain('button "Submit"');
      expect(result.refs).toHaveProperty("e1");
      expect(result.labels).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("screenshotWithLabelsViaPlaywright (fullpage)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards fullPage:true to page.screenshot and uses doc-space annotations", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 1000 });
    const screenshot = vi.fn(async () => Buffer.from("FULL"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => ({ x: 10, y: 200, width: 50, height: 20 }),
    });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" } },
      fullPage: true,
    });

    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
    // doc-space: scroll y=1000 + bbox y=200 = 1200
    expect(result.annotations[0]?.box.y).toBe(1200);
    expect(result.annotations[0]?.box.x).toBe(10);
  });
});

describe("screenshotWithLabelsViaPlaywright (element/ref)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses refLocator.screenshot for ref mode and projects relative to element", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    // First call resolves the element rect (container), second resolves e1 annotation bbox.
    const boundingBox = vi
      .fn<() => Promise<{ x: number; y: number; width: number; height: number } | null>>()
      .mockResolvedValueOnce({ x: 50, y: 100, width: 200, height: 300 })
      .mockResolvedValueOnce({ x: 60, y: 110, width: 30, height: 20 });
    const elementScreenshot = vi.fn(async () => Buffer.from("ELEM"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot: vi.fn() });
    setPwToolsCoreCurrentRefLocator({ boundingBox, screenshot: elementScreenshot });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" } },
      ref: "container",
    });

    expect(elementScreenshot).toHaveBeenCalledTimes(1);
    // Element-relative: doc(60,110) - elementRect(50,100) = (10,10)
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.box).toEqual({ x: 10, y: 10, width: 30, height: 20 });
  });

  it.each(["element", "ref"] as const)(
    "guards a safe labeled %s screenshot through the full navigation window",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const navigation = createNavigationAwarePage();
        const evaluate = evaluateMockReturning({ x: 0, y: 0 });
        const elementScreenshot = vi.fn(async () => Buffer.from("SAFE"));
        const elementLocator = {
          boundingBox: vi.fn(async () => ({ x: 50, y: 100, width: 200, height: 300 })),
          screenshot: elementScreenshot,
        };
        const refBoundingBox = vi
          .fn<() => Promise<{ x: number; y: number; width: number; height: number }>>()
          .mockResolvedValueOnce({ x: 50, y: 100, width: 200, height: 300 })
          .mockResolvedValueOnce({ x: 60, y: 110, width: 30, height: 20 });
        const page = {
          ...navigation.page,
          evaluate,
          locator: vi.fn(() => ({ first: () => elementLocator })),
          screenshot: vi.fn(async () => Buffer.from("PAGE")),
        };
        setPwToolsCoreCurrentPage(page);
        setPwToolsCoreCurrentRefLocator({
          boundingBox:
            mode === "ref"
              ? refBoundingBox
              : vi.fn(async () => ({ x: 60, y: 110, width: 30, height: 20 })),
          screenshot: elementScreenshot,
        });

        const task = mod.screenshotWithLabelsViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          refs: { e1: { role: "button" } },
          ...(mode === "element" ? { element: "#container" } : { ref: "container" }),
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(elementScreenshot).toHaveBeenCalledTimes(1);
        expect(navigation.listeners.size).toBe(1);
        expect(sessionMocks.withPageNavigationRequestGuard).toHaveBeenCalledWith(
          expect.objectContaining({
            page,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
          }),
        );

        await vi.advanceTimersByTimeAsync(250);
        await expect(task).resolves.toMatchObject({ buffer: Buffer.from("SAFE") });
        expect(navigation.listeners.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["element", "ref"] as const)(
    "rejects a blocked navigation triggered by a labeled %s screenshot",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const navigation = createNavigationAwarePage();
        const evaluate = evaluateMockReturning({ x: 0, y: 0 });
        const elementScreenshot = vi.fn(async () => {
          navigation.navigate("http://169.254.169.254/latest/meta-data");
          return Buffer.from("BLOCKED");
        });
        const elementLocator = {
          boundingBox: vi.fn(async () => ({ x: 50, y: 100, width: 200, height: 300 })),
          screenshot: elementScreenshot,
        };
        const refBoundingBox = vi
          .fn<() => Promise<{ x: number; y: number; width: number; height: number }>>()
          .mockResolvedValueOnce({ x: 50, y: 100, width: 200, height: 300 })
          .mockResolvedValueOnce({ x: 60, y: 110, width: 30, height: 20 });
        const page = {
          ...navigation.page,
          evaluate,
          locator: vi.fn(() => ({ first: () => elementLocator })),
          screenshot: vi.fn(async () => Buffer.from("PAGE")),
        };
        const blockedError = createBlockedNavigationError();
        sessionMocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(blockedError);
        setPwToolsCoreCurrentPage(page);
        setPwToolsCoreCurrentRefLocator({
          boundingBox:
            mode === "ref"
              ? refBoundingBox
              : vi.fn(async () => ({ x: 60, y: 110, width: 30, height: 20 })),
          screenshot: elementScreenshot,
        });

        const task = mod.screenshotWithLabelsViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          refs: { e1: { role: "button" } },
          ...(mode === "element" ? { element: "#container" } : { ref: "container" }),
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
        });
        const rejection = expect(task).rejects.toBe(blockedError);

        await vi.advanceTimersByTimeAsync(0);
        expect(elementScreenshot).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        await rejection;
        expect(navigationGuardMocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith(
          expect.objectContaining({ url: "http://169.254.169.254/latest/meta-data" }),
        );
        expect(sessionMocks.quarantineBlockedNavigationTargetForError).toHaveBeenCalledWith(
          expect.objectContaining({ error: blockedError, page, targetId: "T1" }),
        );
        expect(navigation.listeners.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("throws when ref/element cannot be resolved", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    setPwToolsCoreCurrentPage({ evaluate, screenshot: vi.fn() });
    setPwToolsCoreCurrentRefLocator({
      boundingBox: async () => null,
      screenshot: vi.fn(),
    });

    await expect(
      mod.screenshotWithLabelsViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        refs: { e1: { role: "button" } },
        ref: "missing",
      }),
    ).rejects.toThrow(/element not found/i);
  });
});

describe("screenshotWithLabelsViaPlaywright (skipped accounting)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts refs whose boundingBox is null toward skipped", async () => {
    const evaluate = evaluateMockReturning({ x: 0, y: 0 });
    const screenshot = vi.fn(async () => Buffer.from("PNG"));
    setPwToolsCoreCurrentPage({ evaluate, screenshot });
    // Two refs: first returns a box, second returns null (e.g. element detached).
    const boundingBox = vi
      .fn<() => Promise<{ x: number; y: number; width: number; height: number } | null>>()
      .mockResolvedValueOnce({ x: 10, y: 20, width: 30, height: 40 })
      .mockResolvedValueOnce(null);
    setPwToolsCoreCurrentRefLocator({ boundingBox });

    const result = await mod.screenshotWithLabelsViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      refs: { e1: { role: "button" }, e2: { role: "link" } },
    });

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]?.ref).toBe("e1");
    expect(result.skipped).toBe(1);
  });
});
