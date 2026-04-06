import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core interaction navigation guard", () => {
  it("runs the post-click navigation guard when navigation starts shortly after the click resolves", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/json/list";
          for (const listener of listeners) {
            listener();
          }
        }, 0);
      });
      const page = {
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.runAllTimersAsync();
      await task;

      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the post-click navigation guard with the resolved SSRF policy", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:9222/json/version")
        .mockReturnValue("http://127.0.0.1:9222/json/list"),
    };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    const blocked = new Error("blocked interaction navigation");
    getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(blocked);

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toThrow("blocked interaction navigation");

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("runs the post-evaluate navigation guard after page evaluation", async () => {
    const page = {
      evaluate: vi.fn(async () => "ok"),
      url: vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:9222/json/version")
        .mockReturnValue("http://127.0.0.1:9222/json/list"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      fn: "() => location.href = 'http://127.0.0.1:9222/json/version'",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result).toBe("ok");
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("does not run the post-click navigation guard when the url is unchanged", async () => {
    const click = vi.fn(async () => {});
    const page = { url: vi.fn(() => "http://127.0.0.1:9222/json/version") };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
  });

  it("does not run the post-evaluate navigation guard when the url is unchanged", async () => {
    const page = {
      evaluate: vi.fn(async () => "ok"),
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      fn: "() => 1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result).toBe("ok");
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).not.toHaveBeenCalled();
  });

  it("propagates the SSRF policy through batch interaction actions", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi.fn().mockReturnValueOnce("about:blank").mockReturnValue("https://example.com/after"),
    };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.batchViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ssrfPolicy: { allowPrivateNetwork: false },
      actions: [{ kind: "click", ref: "1" }],
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
  });

  it("runs the post-evaluate navigation guard when evaluate rejects after triggering navigation", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const page = {
        evaluate: vi.fn(async () => {
          setTimeout(() => {
            currentUrl = "http://127.0.0.1:9222/json/list";
            for (const listener of listeners) {
              listener();
            }
          }, 0);
          throw new Error("evaluate failed after scheduling navigation");
        }),
        on: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: () => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("blocked interaction navigation");
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        fn: "() => location.href = 'http://127.0.0.1:9222/json/list'",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const expectation = expect(task).rejects.toThrow("blocked interaction navigation");

      await vi.runAllTimersAsync();
      await expectation;

      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
