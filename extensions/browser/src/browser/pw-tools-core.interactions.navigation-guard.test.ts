import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { heldAction, managedDownload, withFakeTimers } from "./pw-tools-core.guard-test-support.js";
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
function act(
  action: Parameters<typeof executeActViaPlaywright>[0]["action"],
  options: Pick<Parameters<typeof executeActViaPlaywright>[0], "signal" | "evaluateEnabled"> = {},
) {
  return executeActViaPlaywright({ ...strict(), action, ...options });
}

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
function holdClick(options: Partial<Parameters<typeof mod.clickViaPlaywright>[0]> = {}) {
  const hover = vi.fn(async () => {});
  const click = vi.fn(async () => {});
  install({ url: vi.fn(() => "https://example.test/hold") }, { hover, click });
  return {
    hover,
    click,
    task: mod.clickViaPlaywright({ ...target, ref: "1", delayMs: 5_000, ...options }),
  };
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
  const events = new EventEmitter();
  const page = {
    mainFrame: vi.fn(() => mainFrame),
    on: vi.fn(events.on.bind(events)),
    off: vi.fn(events.off.bind(events)),
    url: vi.fn(() => url),
  };
  return {
    page,
    listenerCount: () => events.listenerCount("framenavigated"),
    emit: (frame: object = mainFrame) => events.emit("framenavigated", frame),
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
    { phase: "delayed", duration: 0, blocked: false },
    { phase: "in-flight", duration: 30, blocked: false },
    { phase: "delayed", duration: 0, blocked: true },
    { phase: "in-flight", duration: 30, blocked: true },
  ])(
    "checks $phase subframe URLs before rewrite or main-frame blocking (blocked=$blocked)",
    async ({ duration, blocked }) => {
      const page = subframeClick({
        duration,
        rewrite: !blocked,
        mainUrl: blocked ? "http://127.0.0.1:8080/internal" : undefined,
      });
      if (blocked) {
        checkFrame.mockRejectedValueOnce(new Error("subframe blocked"));
        complete.mockRejectedValueOnce(new Error("main frame blocked"));
        await expect(settle(strictClick)).rejects.toThrow("main frame blocked");
        expectComplete(page);
      } else {
        await settle(strictClick);
        expect(checkFrame).toHaveBeenCalledWith({
          ssrfPolicy: { allowPrivateNetwork: false },
          url: privateFrameUrl,
        });
      }
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
    expect(session.withPageNavigationRequestGuard).toHaveBeenCalledBefore(page.evaluate);
  });

  it("deduplicates delayed navigation guards across repeated interactions and a same-URL reload", async () => {
    await withFakeTimers(async () => {
      const { page, listenerCount, emit } = navigationPage();
      install(page, { click: vi.fn(async () => {}) });
      const first = strictClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(listenerCount()).toBe(1);
      const second = strictClick();
      await vi.advanceTimersByTimeAsync(0);
      expect(listenerCount()).toBe(1);
      emit();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([first, second]);
      expect(complete).toHaveBeenCalledTimes(3);
      expect(listenerCount()).toBe(0);
    });
  });

  it.each([false, true])("runs statement-body evaluate sources (ref=%s)", async (ref) => {
    const source = ref
      ? "const text = el.textContent; return text;"
      : "const value = 41; return value + 1;";
    const evaluate = ref
      ? vi.fn(async (fn: (el: Element, args: unknown) => unknown, args: unknown) =>
          fn({ textContent: "Ada" } as Element, args),
        )
      : vi.fn(async (fn: (args: unknown) => unknown, args: unknown) => fn(args));
    install(
      { url: vi.fn(() => localPageUrl), ...(!ref && { evaluate }) },
      ref ? { evaluate } : undefined,
    );
    expect(
      await mod.evaluateViaPlaywright({ ...target, ref: ref ? "1" : undefined, fn: source }),
    ).toBe(ref ? "Ada" : 42);
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: ref
        ? "async (el) => {\nconst text = el.textContent; return text;\n}"
        : "async () => {\nconst value = 41; return value + 1;\n}",
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
    expect(navigation.listenerCount()).toBe(0);
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

  it("returns click downloads without adding a second policy grace", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const download = managedDownload("report.pdf");
    const drain = vi.fn(async () => [download]);
    const dispose = captureDownloads(drain);
    install(page, { click: vi.fn(async () => {}) });
    const result = await settle(() => act({ kind: "click", ref: "1" }));
    expect(result.downloads).toEqual([download]);
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
    await expect(act(hoverAction)).rejects.toBe(blocked);
    expect(session.quarantineBlockedNavigationTarget).not.toHaveBeenCalled();
  });

  it("retains the pre-existing download grace when a guarded hover aborts", async () => {
    const ctrl = new AbortController();
    const hover = heldAction();
    const drain = vi.fn(async () => undefined);
    const dispose = captureDownloads(drain);
    install({ url: vi.fn(() => "https://example.com") }, { hover: hover.run });
    const task = act(hoverAction, { signal: ctrl.signal });
    await hover.started;
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
      act(
        { kind: "wait", fn: "() => false" },
        {
          evaluateEnabled: true,
          signal: ctrl.signal,
        },
      ),
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
    await expect(settle(() => act(hoverAction))).rejects.toBe(blocked);
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
        ...target,
        assertCurrent: () => {
          events.push("assert");
          queueMicrotask(() => events.push("yield"));
        },
      };
      await {
        type: () => mod.typeViaPlaywright({ ...opts, ref: "1", text: "review", submit: true }),
        wait: () => waitForViaPlaywright({ ...opts, fn: "() => true" }),
        resize: () => resizeViewportViaPlaywright({ ...opts, width: 800, height: 600 }),
      }[kind]();
      expect(effect).toHaveBeenCalledTimes(kind === "resize" ? 1 : 2);
    },
  );

  it("still awaits an asynchronous authority and preserves its rejection", async () => {
    const admission = heldAction();
    const click = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({});
    setPwToolsCoreCurrentRefLocator({ click });
    const pending = mod.clickViaPlaywright({
      ...target,
      ref: "1",
      assertCurrent: admission.run,
    });
    const rejected = expect(pending).rejects.toThrow("actor revoked");
    await admission.started;
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
        ...target,
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
    await withFakeTimers(async () => {
      const ctrl = new AbortController();
      const { task, hover, click } = holdClick({
        ssrfPolicy: { allowPrivateNetwork: false },
        signal: ctrl.signal,
      });
      const rejected = expect(task).rejects.toThrow("aborted by test");

      // Enter the click-and-hold delay, then abort 100ms into the 5s hold.
      await vi.advanceTimersByTimeAsync(100);
      expect(hover).toHaveBeenCalledTimes(1);
      ctrl.abort(new Error("aborted by test"));

      // Join the aborted hold and navigation grace without waiting out the hold.
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      await expect(task).rejects.toBeInstanceOf(Error);
      expect(click).not.toHaveBeenCalled();
      expect(session.forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });

  it("still waits the full hold delay before clicking when not aborted", async () => {
    await withFakeTimers(async () => {
      const { task, hover, click } = holdClick();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(hover).toHaveBeenCalledTimes(1);
      expect(click).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(click).toHaveBeenCalledTimes(1);
    });
  });
});
