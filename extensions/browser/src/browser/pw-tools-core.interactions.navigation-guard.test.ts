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
  it("does not wait for the grace window after a successful non-navigating click", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      const click = vi.fn(async () => {});
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
        url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const completion = vi.fn();
      const task = mod
        .clickViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
        })
        .then(completion);

      await vi.advanceTimersByTimeAsync(0);
      expect(completion).toHaveBeenCalledTimes(1);
      expect(listeners.size).toBe(1);
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      expect(listeners.size).toBe(0);
      await task;
    } finally {
      vi.useRealTimers();
    }
  });

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
        }, 10);
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

      const completion = vi.fn();
      const task = mod
        .clickViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
        })
        .then(completion);

      await vi.advanceTimersByTimeAsync(0);
      expect(completion).toHaveBeenCalledTimes(1);
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
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

  it("ignores subframe framenavigated events before the main frame navigates", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = {};
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe);
          }
        }, 10);
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/json/list";
          for (const listener of listeners) {
            listener(mainFrame);
          }
        }, 20);
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
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

      await vi.advanceTimersByTimeAsync(10);
      expect(listeners.size).toBe(1);
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
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

  it("deduplicates delayed navigation guards across repeated successful interactions", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {});
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

      await mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      expect(listeners.size).toBe(1);

      await mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      expect(listeners.size).toBe(1);

      currentUrl = "http://127.0.0.1:9222/json/list";
      for (const listener of Array.from(listeners)) {
        listener();
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(1);
      expect(listeners.size).toBe(0);
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

  it("skips interaction navigation guards when no explicit SSRF policy is provided", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        currentUrl = "http://127.0.0.1:9222/json/list";
        for (const listener of listeners) {
          listener(mainFrame);
        }
      });
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        on: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.add(listener);
          }
        }),
        off: vi.fn((event: string, listener: (frame: object) => void) => {
          if (event === "framenavigated") {
            listeners.delete(listener);
          }
        }),
        url: vi.fn(() => currentUrl),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      await mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      });
      await vi.runAllTimersAsync();

      expect(page.on).not.toHaveBeenCalled();
      expect(page.off).not.toHaveBeenCalled();
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it("does not run the navigation guard when only the URL hash changes (same-document navigation)", async () => {
    const click = vi.fn(async () => {});
    const page = {
      url: vi
        .fn()
        .mockReturnValueOnce("https://example.com/page")
        .mockReturnValue("https://example.com/page#section"),
    };
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

  it("runs the navigation guard when a same-URL reload fires framenavigated during a click", async () => {
    // A page reload (form submit, location.reload()) keeps the URL identical but
    // fires framenavigated. Prior to the isHashOnlyNavigation fix, didCrossDocumentUrlChange
    // would treat currentUrl === previousUrl as "no navigation" and skip the SSRF guard.
    const listeners = new Set<() => void>();
    const sameUrl = "http://192.168.1.1/admin";
    const click = vi.fn(async () => {
      // Simulate reload: URL stays the same but framenavigated fires during the click
      for (const listener of listeners) {
        listener();
      }
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
      url: vi.fn(() => sameUrl),
    };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);

    await mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
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
