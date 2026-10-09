import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.interactions.actions.js");
const { executeActViaPlaywright } = await import("./pw-tools-core.interactions.execution.js");
const { waitForViaPlaywright } = await import("./pw-tools-core.interactions.content.js");
const { resizeViewportViaPlaywright } = await import("./pw-tools-core.snapshot.js");
const session = getPwToolsCoreSessionMocks();
const complete = session.assertPageNavigationCompletedSafely;
const checkFrame = getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed;
const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "T1" };
const strict = () => ({ ...target, ssrfPolicy: { allowPrivateNetwork: false } });
const privateFrameUrl = "http://169.254.169.254/latest/meta-data/";
const localPageUrl = "http://127.0.0.1:9222/json/version";
const strictClick = () => mod.clickViaPlaywright({ ...strict(), ref: "1" });
const hoverAction = { kind: "hover", ref: "1" } as const;
const downloadGrace = { firstEventGraceMs: 250, maxWaitMs: 1_000, quietMs: 250 };

function install(page: Record<string, unknown>, locator?: Record<string, unknown>) {
  setPwToolsCoreCurrentPage(page);
  if (locator) {
    setPwToolsCoreCurrentRefLocator(locator);
  }
}
function expectComplete(page: Record<string, unknown>) {
  expect(complete).toHaveBeenCalledWith({ ...strict(), page, response: null });
}
function expectQuarantine(page: Record<string, unknown>) {
  expect(session.quarantineBlockedNavigationTarget).toHaveBeenCalledWith({ ...target, page });
}
function captureDownloads(
  drain: ReturnType<typeof session.beginActionDownloadCaptureOnPage>["drain"],
) {
  const dispose = vi.fn();
  session.beginActionDownloadCaptureOnPage.mockReturnValueOnce({ drain, dispose });
  return dispose;
}
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  return await run().finally(() => vi.useRealTimers());
}
async function settle<T>(run: () => Promise<T>): Promise<T> {
  return await withFakeTimers(async () => {
    // Handle rejection before advancing timers, including when a frame is denied early.
    const result = run().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const outcome = await result;
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  });
}
function navigationPage(initialUrl = localPageUrl, mainFrame: object = {}) {
  let url = initialUrl;
  const listeners = new Set<(frame: object) => void>();
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
    url: vi.fn(() => url),
  };
  const emit = (frame: object = mainFrame) => {
    for (const listener of listeners) {
      listener(frame);
    }
  };
  return {
    page,
    listeners,
    emit,
    setUrl: (next: string) => {
      url = next;
    },
  };
}
function subframeClick(
  options: { duration?: number; frameUrl?: string; rewrite?: boolean; mainUrl?: string } = {},
) {
  const mainFrame = {};
  let url = options.frameUrl ?? privateFrameUrl;
  const subframe = { url: vi.fn(() => url) };
  const navigation = navigationPage("https://attacker.example.com/page", mainFrame);
  install(navigation.page, {
    click: vi.fn(async () => {
      setTimeout(() => navigation.emit(subframe), 10);
      if (options.rewrite || options.mainUrl) {
        setTimeout(() => {
          if (options.rewrite) {
            url = "https://example.com/embed";
          }
          if (options.mainUrl) {
            navigation.setUrl(options.mainUrl);
            navigation.emit(mainFrame);
          }
        }, 20);
      }
      if (options.duration) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.duration);
        });
      }
    }),
  });
  return navigation.page;
}

describe("pw-tools-core interaction navigation guard", () => {
  it.each([
    { phase: "delayed", duration: 0 },
    { phase: "in-flight", duration: 30 },
  ])(
    "snapshots $phase subframe URLs before later rewrites make them look safe",
    async ({ duration }) => {
      subframeClick({ duration, rewrite: true });
      await settle(strictClick);
      expect(checkFrame).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: privateFrameUrl,
      });
    },
  );

  it.each([
    { phase: "a delayed", duration: 0 },
    { phase: "an in-flight", duration: 30 },
  ])(
    "still quarantines the main frame when $phase subframe block fires first",
    async ({ duration }) => {
      const page = subframeClick({ duration, mainUrl: "http://127.0.0.1:8080/internal" });
      checkFrame.mockRejectedValueOnce(new Error("subframe blocked"));
      complete.mockRejectedValueOnce(new Error("main frame blocked"));
      await expect(settle(strictClick)).rejects.toThrow("main frame blocked");
      expectComplete(page);
    },
  );

  it("does not stop watching for a later main-frame navigation after a harmless subframe hop", async () => {
    const page = subframeClick({
      frameUrl: "about:blank",
      mainUrl: "http://127.0.0.1:9222/json/list",
    });
    await settle(strictClick);
    expect(checkFrame).not.toHaveBeenCalled();
    expectComplete(page);
  });

  it("checks delayed subframe navigations in the action-error recovery path", async () => {
    const navigation = navigationPage("https://attacker.example.com/page", {});
    const page = Object.assign(navigation.page, {
      evaluate: vi.fn(async () => {
        setTimeout(() => navigation.emit({ url: () => privateFrameUrl }), 10);
        throw new Error("evaluate failed");
      }),
    });
    install(page);
    checkFrame.mockRejectedValueOnce(new Error("SSRF blocked: private network"));
    await expect(
      settle(() => mod.evaluateViaPlaywright({ ...strict(), fn: "() => 1" })),
    ).rejects.toThrow("SSRF blocked: private network");
    expect(complete).toHaveBeenCalledTimes(1);
    expectComplete(page);
    expect(
      expectDefined(
        session.withPageNavigationRequestGuard.mock.invocationCallOrder[0],
        "request guard invocation",
      ),
    ).toBeLessThan(
      expectDefined(page.evaluate.mock.invocationCallOrder[0], "page evaluation invocation"),
    );
  });

  it("deduplicates delayed navigation guards across repeated successful interactions", async () => {
    await withFakeTimers(async () => {
      const { page, listeners, emit, setUrl } = navigationPage();
      install(page, { click: vi.fn(async () => {}) });
      const first = strictClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);
      const second = strictClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);
      setUrl("http://127.0.0.1:9222/json/list");
      emit();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([first, second]);
      expect(complete).toHaveBeenCalledTimes(3);
      expect(listeners.size).toBe(0);
    });
  });

  it("runs statement-body page evaluate sources", async () => {
    const page = {
      evaluate: vi.fn(async (fn: (args: unknown) => unknown, args: unknown) => fn(args)),
      url: vi.fn(() => localPageUrl),
    };
    install(page);
    expect(
      await mod.evaluateViaPlaywright({ ...target, fn: "const value = 41; return value + 1;" }),
    ).toBe(42);
    expect(page.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async () => {\nconst value = 41; return value + 1;\n}",
    });
  });

  it("runs statement-body ref evaluate sources", async () => {
    const locator = {
      evaluate: vi.fn(async (fn: (el: Element, args: unknown) => unknown, args: unknown) =>
        fn({ textContent: "Ada" } as Element, args),
      ),
    };
    install({ url: vi.fn(() => localPageUrl) }, locator);
    expect(
      await mod.evaluateViaPlaywright({
        ...target,
        ref: "1",
        fn: "const text = el.textContent; return text;",
      }),
    ).toBe("Ada");
    expect(locator.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async (el) => {\nconst text = el.textContent; return text;\n}",
    });
  });

  it("propagates blocked delayed submit navigation instead of reporting type success", async () => {
    const navigation = navigationPage("https://example.com/form");
    install(navigation.page, {
      fill: vi.fn(async () => {}),
      press: vi.fn(async () => {
        setTimeout(() => {
          navigation.setUrl("http://127.0.0.1:9222/private-target");
          navigation.emit();
        }, 10);
      }),
    });
    complete.mockRejectedValueOnce(new Error("blocked delayed interaction navigation"));
    await expect(
      settle(() => mod.typeViaPlaywright({ ...strict(), ref: "1", text: "hello", submit: true })),
    ).rejects.toThrow("blocked delayed interaction navigation");
    expect(navigation.listeners.size).toBe(0);
  });

  it("runs the final committed-URL check after a same-document hash change", async () => {
    const page = {
      url: vi
        .fn()
        .mockReturnValueOnce("https://example.com/page")
        .mockReturnValue("https://example.com/page#section"),
    };
    install(page, { click: vi.fn(async () => {}) });
    await settle(strictClick);
    expectComplete(page);
  });

  it("runs the navigation guard when a same-URL reload fires framenavigated during a click", async () => {
    const navigation = navigationPage("http://192.168.1.1/admin");
    install(navigation.page, {
      click: vi.fn(async () => {
        navigation.emit();
      }),
    });
    await settle(strictClick);
    expectComplete(navigation.page);
  });

  it("returns click downloads without adding a second policy grace", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const download = {
      url: "https://example.com/report.pdf",
      suggestedFilename: "report.pdf",
      path: "/tmp/openclaw/downloads/report.pdf",
    };
    const drain = vi.fn(async () => [download]);
    const dispose = captureDownloads(drain);
    install(page, { click: vi.fn(async () => {}) });
    const result = await settle(() =>
      executeActViaPlaywright({ ...strict(), action: { kind: "click", ref: "1" } }),
    );
    expect(result.downloads).toEqual([
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    expect(drain).toHaveBeenCalledWith({ ...downloadGrace, firstEventGraceMs: 0 });
    expect(dispose).toHaveBeenCalledOnce();
    expect(session.beginActionDownloadCaptureOnPage).toHaveBeenCalledWith(page, {
      beforeSave: expect.any(Function),
    });
  });

  it("does not quarantine a source page preserved after policy denial", async () => {
    const blocked = Object.assign(new Error("browser navigation blocked by policy"), {
      name: "SsrFBlockedError",
    });
    install({ url: vi.fn(() => "about:blank") }, { hover: vi.fn(async () => {}) });
    session.withPageNavigationRequestGuard.mockRejectedValueOnce(blocked);
    session.wasBrowserNavigationSourcePreservedAfterPolicyDenial
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    await expect(executeActViaPlaywright({ ...strict(), action: hoverAction })).rejects.toBe(
      blocked,
    );
    expect(session.quarantineBlockedNavigationTarget).not.toHaveBeenCalled();
  });

  it("retains the pre-existing download grace when a guarded hover aborts", async () => {
    const ctrl = new AbortController();
    const started = Promise.withResolvers<void>();
    const hover = Promise.withResolvers<void>();
    const drain = vi.fn(async () => undefined);
    const dispose = captureDownloads(drain);
    install(
      { url: vi.fn(() => "https://example.com") },
      {
        hover: vi.fn(() => {
          started.resolve();
          return hover.promise;
        }),
      },
    );
    const task = executeActViaPlaywright({
      ...strict(),
      action: hoverAction,
      signal: ctrl.signal,
    });
    await started.promise;
    ctrl.abort(new Error("aborted by test"));
    expect(drain).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    hover.resolve();
    await expect(task).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith(downloadGrace);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("retains the download grace when an executable wait aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("aborted by test"));
    const page = {
      url: vi.fn(() => "https://example.com"),
      waitForFunction: vi.fn(async () => {}),
    };
    const drain = vi.fn(async () => undefined);
    const dispose = captureDownloads(drain);
    install(page);
    await expect(
      executeActViaPlaywright({
        ...strict(),
        action: { kind: "wait", fn: "() => false" },
        evaluateEnabled: true,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted by test");
    expect(drain).toHaveBeenCalledWith(downloadGrace);
    expect(dispose).toHaveBeenCalledOnce();
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("blocks a private final URL after an earlier safe navigation", async () => {
    let currentUrl = "https://example.com";
    const blocked = Object.assign(new Error("final browser URL blocked by policy"), {
      name: "SsrFBlockedError",
    });
    const page = { url: vi.fn(() => currentUrl) };
    install(page, {
      hover: vi.fn(async () => {
        currentUrl = "https://example.org/safe";
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:18080/private-final";
        }, 200);
      }),
    });
    complete.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      await session.quarantineBlockedNavigationTarget({ ...target, page });
      throw blocked;
    });
    await expect(
      settle(() => executeActViaPlaywright({ ...strict(), action: hoverAction })),
    ).rejects.toBe(blocked);
    expect(complete).toHaveBeenCalledTimes(2);
    expectQuarantine(page);
  });

  it("quarantines the target without closing it when an action download fails policy", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const blocked = Object.assign(new Error("blocked action download"), {
      name: "InvalidBrowserNavigationUrlError",
    });
    const dispose = captureDownloads(
      vi.fn(async () => {
        throw blocked;
      }),
    );
    install(page, { click: vi.fn(async () => {}) });
    await expect(
      executeActViaPlaywright({ ...target, action: { kind: "click", ref: "1" } }),
    ).rejects.toBe(blocked);
    expectQuarantine(page);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("resident interaction authority", () => {
  it.each(["type", "wait", "resize"] as const)(
    "starts each %s effect in the same turn as its final assertion",
    async (kind) => {
      const events: string[] = [];
      const effect = vi.fn(async () => {
        expect(events.at(-1)).toBe("assert");
        events.push("effect");
      });
      setPwToolsCoreCurrentRefLocator({ click: effect, fill: effect, press: effect });
      setPwToolsCoreCurrentPage({
        setViewportSize: effect,
        evaluateHandle: async () => {
          await effect();
          return { dispose: async () => {} };
        },
        waitForFunction: effect,
      });
      const opts = {
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        assertCurrent: () => {
          events.push("assert");
          queueMicrotask(() => events.push("yield"));
        },
      };
      switch (kind) {
        case "type":
          await mod.typeViaPlaywright({ ...opts, ref: "1", text: "review", submit: true });
          break;
        case "wait":
          await waitForViaPlaywright({ ...opts, fn: "() => true" });
          break;
        case "resize":
          await resizeViewportViaPlaywright({ ...opts, width: 800, height: 600 });
          break;
      }
      expect(effect).toHaveBeenCalledTimes(kind === "resize" ? 1 : 2);
    },
  );

  it("still awaits an asynchronous authority and preserves its rejection", async () => {
    const entered = Promise.withResolvers<void>();
    const admission = Promise.withResolvers<void>();
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({});
    setPwToolsCoreCurrentRefLocator({ click });
    const pending = mod.clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      assertCurrent: () => {
        entered.resolve();
        return admission.promise;
      },
    });
    const rejected = expect(pending).rejects.toThrow("actor revoked");
    await entered.promise;
    expect(click).not.toHaveBeenCalled();
    admission.reject(new Error("actor revoked"));
    await rejected;
    expect(click).not.toHaveBeenCalled();
  });

  it("rechecks resize authority after clearing the previous metrics owner", async () => {
    let current = true;
    const send = vi.fn(async () => {
      current = false;
    });
    const setViewportSize = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({ setViewportSize });
    Object.assign(getPwToolsCoreSessionMocks().ensurePageState(), {
      emulation: {
        metricsOwner: { viewport: { width: 400, height: 300 }, session: { send } },
      },
    });
    await expect(
      resizeViewportViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        width: 800,
        height: 600,
        assertCurrent: () => {
          if (!current) {
            throw new Error("actor revoked");
          }
        },
      }),
    ).rejects.toThrow("actor revoked");
    expect(send).toHaveBeenCalledWith("Emulation.clearDeviceMetricsOverride");
    expect(setViewportSize).not.toHaveBeenCalled();
  });
});

describe("clickViaPlaywright (hold-delay abort)", () => {
  it("unwinds the hold-delay action chain promptly when aborted mid-delay", async () => {
    vi.useFakeTimers();
    try {
      const hover = vi.fn(async () => {});
      const click = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ hover, click });
      setPwToolsCoreCurrentPage({ url: vi.fn(() => "https://example.test/hold") });

      const ctrl = new AbortController();
      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        delayMs: 5_000,
        ssrfPolicy: { allowPrivateNetwork: false },
        signal: ctrl.signal,
      });
      const settled = task.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );

      // Enter the click-and-hold delay, then abort 100ms into the 5s hold.
      await vi.advanceTimersByTimeAsync(100);
      expect(hover).toHaveBeenCalledTimes(1);
      ctrl.abort(new Error("aborted by test"));

      // Join the aborted hold and navigation grace without waiting out the hold.
      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await settled;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(Error);
        expect((outcome.reason as Error).message).toContain("aborted by test");
      }
      expect(click).not.toHaveBeenCalled();
      expect(
        getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget,
      ).not.toHaveBeenCalled();
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(1);
      expect(click).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits the full hold delay before clicking when not aborted", async () => {
    vi.useFakeTimers();
    try {
      const hover = vi.fn(async () => {});
      const click = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ hover, click });
      setPwToolsCoreCurrentPage({ url: vi.fn(() => "https://example.test/hold") });

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        delayMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(hover).toHaveBeenCalledTimes(1);
      expect(click).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
