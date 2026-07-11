// Browser tests cover pw tools core.interactions.navigation guard plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreNavigationGuardMocks,
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

function createMutableFrame(initialUrl: string) {
  let currentUrl = initialUrl;
  return {
    frame: {
      url: vi.fn(() => currentUrl),
    },
    setUrl: (nextUrl: string) => {
      currentUrl = nextUrl;
    },
  };
}

describe("pw-tools-core interaction navigation guard", () => {
  it("gates the exact selected page after installing the request guard", async () => {
    let currentUrl = "https://safe.example/start";
    const blockedUrl = "http://169.254.169.254/latest/meta-data/";
    const blocked = new Error("blocked interaction preflight");
    blocked.name = "SsrFBlockedError";
    const click = vi.fn(async () => {});
    const page = { url: vi.fn(() => currentUrl) };
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage(page);
    getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
      async ({ action }: { action: () => Promise<unknown> }) => {
        currentUrl = blockedUrl;
        return await action();
      },
    );
    getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockImplementationOnce(
      async ({ url }: { url: string }) => {
        if (url === blockedUrl) {
          throw blocked;
        }
      },
    );

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      }),
    ).rejects.toBe(blocked);

    expect(click).not.toHaveBeenCalled();
    expect(
      getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mock.invocationCallOrder[0],
    ).toBeLessThan(
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mock
        .invocationCallOrder[0]!,
    );
  });

  it("keeps resize functional on an unchanged private page", async () => {
    let currentUrl = "https://safe.example/start";
    const privateUrl = "http://127.0.0.1:8080/admin";
    const setViewportSize = vi.fn(async () => {});
    const page = { setViewportSize, url: vi.fn(() => currentUrl) };
    setPwToolsCoreCurrentPage(page);
    getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
      async ({ action }: { action: () => Promise<unknown> }) => {
        currentUrl = privateUrl;
        return await action();
      },
    );
    await mod.resizeViewportViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      width: 800,
      height: 600,
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(setViewportSize).toHaveBeenCalledOnce();
    expect(
      getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
    ).not.toHaveBeenCalled();
  });

  it("does not dispatch an action aborted during the exact-page policy preflight", async () => {
    const controller = new AbortController();
    let releasePolicy!: () => void;
    const policyPending = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const hover = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({ url: vi.fn(() => "https://safe.example/start") });
    setPwToolsCoreCurrentRefLocator({ hover });
    getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockReturnValueOnce(
      policyPending,
    );

    const task = mod.hoverViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      ssrfPolicy: { allowPrivateNetwork: false },
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledOnce();
    });
    controller.abort(new Error("request aborted during policy preflight"));
    releasePolicy();

    await expect(task).rejects.toThrow("request aborted during policy preflight");
    expect(hover).not.toHaveBeenCalled();
  });

  it("keeps postflight observation until an aborted inner action actually settles", async () => {
    vi.useFakeTimers();
    try {
      const safeUrl = "https://93.184.216.34/start";
      const privateUrl = "http://169.254.169.254/latest/meta-data/";
      let currentUrl = safeUrl;
      let resolveClick!: () => void;
      const clickPending = new Promise<void>((resolve) => {
        resolveClick = resolve;
      });
      const listeners = new Set<() => void>();
      const click = vi.fn(async () => await clickPending);
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
      setPwToolsCoreCurrentPage(page);
      setPwToolsCoreCurrentRefLocator({ click });
      const sessionMocks = getPwToolsCoreSessionMocks();
      let finalizerDone: Promise<void> | undefined;
      sessionMocks.finalizePendingBrowserInteractionAction.mockImplementationOnce(
        (error: unknown, finalizer: () => Promise<void>) => {
          finalizerDone = clickPending.then(finalizer);
          return {
            error: error instanceof Error ? error : new Error("aborted"),
            deferred: true,
          };
        },
      );
      const blocked = Object.assign(new Error("blocked late navigation"), {
        name: "SsrFBlockedError",
      });
      sessionMocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(blocked);
      const controller = new AbortController();

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
      controller.abort(new Error("request ended while click remained pending"));

      await expect(task).rejects.toThrow("request ended while click remained pending");
      expect(listeners.size).toBe(1);
      currentUrl = privateUrl;
      resolveClick();
      await vi.advanceTimersByTimeAsync(250);
      await finalizerDone;

      expect(sessionMocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        page,
        response: null,
        ssrfPolicy: { allowPrivateNetwork: false },
        targetId: "T1",
      });
      expect(sessionMocks.quarantineBlockedNavigationTargetForError).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        error: blocked,
        page,
        targetId: "T1",
      });
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards a pending dialog response through its resumed-page navigation", async () => {
    vi.useFakeTimers();
    try {
      let currentUrl = "https://safe.example/start";
      const blocked = new Error("blocked dialog navigation");
      blocked.name = "SsrFBlockedError";
      const page = { url: vi.fn(() => currentUrl) };
      setPwToolsCoreCurrentPage(page);
      getPwToolsCoreSessionMocks().respondOrArmObservedDialogOnPage.mockImplementationOnce(
        ({
          runResponse,
        }: {
          runResponse: (respond: () => Promise<unknown>, mode: string) => Promise<unknown>;
        }) => ({
          kind: "responding",
          response: runResponse(async () => {
            currentUrl = "http://169.254.169.254/latest/meta-data/";
            return {};
          }, "pending"),
        }),
      );
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.armDialogViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        accept: true,
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toBe(blocked);
      await vi.advanceTimersByTimeAsync(250);
      await rejection;

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

  it("installs a fresh guard when an armed dialog responds later", async () => {
    vi.useFakeTimers();
    try {
      let runResponse:
        | ((respond: () => Promise<unknown>, mode: "pending" | "armed") => Promise<unknown>)
        | undefined;
      let currentUrl = "https://safe.example/start";
      const blocked = new Error("blocked armed dialog navigation");
      blocked.name = "SsrFBlockedError";
      const page = { url: vi.fn(() => currentUrl) };
      setPwToolsCoreCurrentPage(page);
      getPwToolsCoreSessionMocks().respondOrArmObservedDialogOnPage.mockImplementationOnce(
        (opts: { runResponse: typeof runResponse }) => {
          runResponse = opts.runResponse;
          return { kind: "armed" };
        },
      );

      await mod.armDialogViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        accept: false,
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      if (!runResponse) {
        throw new Error("expected armed dialog response owner");
      }
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );
      const task = runResponse(async () => {
        currentUrl = "http://169.254.169.254/latest/meta-data/";
        return {};
      }, "armed");
      const rejection = expect(task).rejects.toBe(blocked);
      await vi.advanceTimersByTimeAsync(250);
      await rejection;

      expect(getPwToolsCoreSessionMocks().withPageNavigationRequestGuard).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a stuck pending dialog response at its bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      const page = { url: vi.fn(() => "https://safe.example/start") };
      setPwToolsCoreCurrentPage(page);
      getPwToolsCoreSessionMocks().respondOrArmObservedDialogOnPage.mockImplementationOnce(
        ({
          runResponse,
        }: {
          runResponse: (respond: () => Promise<unknown>, mode: string) => Promise<unknown>;
        }) => ({
          kind: "responding",
          response: runResponse(async () => await new Promise<never>(() => {}), "pending"),
        }),
      );

      const task = mod.armDialogViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        accept: true,
        timeoutMs: 500,
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("Dialog response timed out after 500ms");
      await vi.advanceTimersByTimeAsync(750);
      await rejection;

      await vi.waitFor(() => {
        expect(
          getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget,
        ).toHaveBeenCalledWith({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ssrfPolicy: { allowPrivateNetwork: false },
          reason: "dialog response aborted",
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a stuck armed dialog response at a fresh bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      let runResponse:
        | ((respond: () => Promise<unknown>, mode: "pending" | "armed") => Promise<unknown>)
        | undefined;
      const page = { url: vi.fn(() => "https://safe.example/start") };
      setPwToolsCoreCurrentPage(page);
      getPwToolsCoreSessionMocks().respondOrArmObservedDialogOnPage.mockImplementationOnce(
        (opts: { runResponse: typeof runResponse }) => {
          runResponse = opts.runResponse;
          return { kind: "armed" };
        },
      );

      await mod.armDialogViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        accept: false,
        timeoutMs: 500,
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      if (!runResponse) {
        throw new Error("expected armed dialog response owner");
      }
      const task = runResponse(async () => await new Promise<never>(() => {}), "armed");
      const rejection = expect(task).rejects.toThrow("Dialog response timed out after 500ms");
      await vi.advanceTimersByTimeAsync(750);
      await rejection;

      await vi.waitFor(() => {
        expect(
          getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget,
        ).toHaveBeenCalledWith({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ssrfPolicy: { allowPrivateNetwork: false },
          reason: "dialog response aborted",
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the grace window before completing a successful non-navigating click", async () => {
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
      expect(completion).not.toHaveBeenCalled();
      expect(listeners.size).toBe(1);
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await task;
      expect(completion).toHaveBeenCalledTimes(1);
      expect(listeners.size).toBe(0);
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
      expect(completion).not.toHaveBeenCalled();
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(completion).not.toHaveBeenCalled();
      expect(listeners.size).toBe(1);
      await vi.advanceTimersByTimeAsync(240);
      await task;
      expect(completion).toHaveBeenCalledTimes(1);

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

  it.each([
    { name: "the first navigation occurs during the action", actionDurationMs: 30 },
    { name: "the first navigation occurs during the grace window", actionDurationMs: 0 },
  ])(
    "keeps the request guard active through a safe-to-private chain when $name",
    async ({ actionDurationMs }) => {
      vi.useFakeTimers();
      try {
        const listeners = new Set<() => void>();
        let currentUrl = "https://safe.example/start";
        let guardActive = false;
        let secondNavigationSawGuard = false;
        const completion = vi.fn();
        getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
          async ({ action }: { action: () => Promise<unknown> }) => {
            guardActive = true;
            try {
              return await action();
            } finally {
              guardActive = false;
            }
          },
        );
        const click = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                currentUrl = "https://safe.example/first";
                for (const listener of listeners) {
                  listener();
                }
              }, 10);
              setTimeout(() => {
                secondNavigationSawGuard = guardActive;
                currentUrl = "http://169.254.169.254/latest/meta-data/";
                for (const listener of listeners) {
                  listener();
                }
              }, 200);
              setTimeout(resolve, actionDurationMs);
            }),
        );
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

        const task = mod
          .clickViaPlaywright({
            cdpUrl: "http://127.0.0.1:18792",
            targetId: "T1",
            ref: "1",
            ssrfPolicy: { allowPrivateNetwork: false },
          })
          .then(completion);

        await vi.advanceTimersByTimeAsync(200);
        expect(secondNavigationSawGuard).toBe(true);
        expect(completion).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(actionDurationMs > 0 ? 80 : 50);
        await task;
        expect(guardActive).toBe(false);
        expect(
          getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
        ).toHaveBeenCalledWith({
          ssrfPolicy: { allowPrivateNetwork: false },
          url: "http://169.254.169.254/latest/meta-data/",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("runs the post-select navigation guard when navigation starts shortly after the select resolves", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "https://example.com/form";
      const selectOption = vi.fn(async () => {
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/private-target";
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
      setPwToolsCoreCurrentRefLocator({ selectOption });
      setPwToolsCoreCurrentPage(page);

      const task = mod.selectOptionViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        values: ["go"],
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
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

  it("checks subframe navigations before a later main-frame navigation", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "https://example.com/embed" };
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
      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledOnce();
      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://127.0.0.1:9222/json/version",
      });

      await vi.advanceTimersByTimeAsync(240);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "https://example.com/embed",
      });
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

  it("blocks subframe-only navigation to a private URL during the post-action grace window", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe);
          }
        }, 10);
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
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("SSRF blocked: private network");
      getPwToolsCoreNavigationGuardMocks()
        .assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(blocked);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("SSRF blocked: private network");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a private subframe committed after a preserved request denial returns", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const privateFrame = { url: () => "http://169.254.169.254/latest/meta-data/" };
      let markClickStarted!: () => void;
      const clickStarted = new Promise<void>((resolve) => {
        markClickStarted = resolve;
      });
      const click = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            markClickStarted();
            setTimeout(() => {
              for (const listener of listeners) {
                listener(privateFrame);
              }
              resolve();
            }, 10);
          }),
      );
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
        url: vi.fn(() => "https://safe.example/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const requestDenial = new Error("direct request blocked with preserved source");
      requestDenial.name = "SsrFBlockedError";
      const committedFrameDenial = new Error("committed private subframe blocked");
      committedFrameDenial.name = "SsrFBlockedError";
      let pendingAction: Promise<unknown> | undefined;
      getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
        async ({ action }: { action: () => Promise<unknown> }) => {
          pendingAction = action();
          void pendingAction.catch(() => {});
          await clickStarted;
          throw requestDenial;
        },
      );
      // This marker models the request guard's successful 204 response: the
      // first denial preserved the source and must not quarantine on its own.
      getPwToolsCoreSessionMocks().wasBrowserNavigationRequestBlockedBeforeDispatch.mockReturnValueOnce(
        true,
      );
      getPwToolsCoreNavigationGuardMocks()
        .assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(committedFrameDenial);

      await expect(
        mod.clickViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          ref: "1",
          ssrfPolicy: { allowPrivateNetwork: false },
        }),
      ).rejects.toBe(requestDenial);
      expect(
        getPwToolsCoreSessionMocks().quarantineBlockedNavigationTargetForError,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(260);
      if (!pendingAction) {
        throw new Error("expected the guarded Playwright action to remain pending");
      }
      await expect(pendingAction).rejects.toBe(committedFrameDenial);
      expect(
        getPwToolsCoreSessionMocks().quarantineBlockedNavigationTargetForError,
      ).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        error: committedFrameDenial,
        page,
        targetId: "T1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks every observed frame URL and gives a later policy denial precedence", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const firstFrame = { url: () => "https://unresolvable.example/" };
      const privateFrame = { url: () => "http://169.254.169.254/latest/meta-data/" };
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(firstFrame);
          }
        }, 10);
        setTimeout(() => {
          for (const listener of listeners) {
            listener(privateFrame);
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
        url: vi.fn(() => "https://safe.example/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);
      const genericError = new Error("DNS lookup failed");
      const policyError = new Error("private destination blocked");
      policyError.name = "SsrFBlockedError";
      getPwToolsCoreNavigationGuardMocks()
        .assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(genericError)
        .mockRejectedValueOnce(policyError);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toBe(policyError);

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a generic final-page failure mask an observed policy denial", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      let currentUrl = "https://safe.example/page";
      const click = vi.fn(async () => {
        setTimeout(() => {
          currentUrl = "http://169.254.169.254/latest/meta-data/";
          for (const listener of listeners) {
            listener(mainFrame);
          }
        }, 10);
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
      const policyError = new Error("private destination blocked");
      policyError.name = "SsrFBlockedError";
      getPwToolsCoreNavigationGuardMocks()
        .assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(policyError);
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        new Error("page context disappeared"),
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toBe(policyError);

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed and quarantines when frame navigation observations overflow", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const click = vi.fn(async () => {
        for (let index = 0; index < 257; index += 1) {
          const frame = { url: () => `https://frame-${index}.example/` };
          for (const listener of listeners) {
            listener(frame);
          }
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
        url: vi.fn(() => "https://safe.example/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow(
        "Too many frame navigations occurred to verify the interaction safely",
      );

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(
        getPwToolsCoreSessionMocks().quarantineBlockedNavigationTargetForError,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ cdpUrl: "http://127.0.0.1:18792", page, targetId: "T1" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("snapshots delayed subframe URLs before later rewrites make them look safe", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = createMutableFrame("http://169.254.169.254/latest/meta-data/");
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe.frame);
          }
        }, 10);
        setTimeout(() => {
          subframe.setUrl("https://example.com/embed");
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
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(230);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://169.254.169.254/latest/meta-data/",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still quarantines the main frame when a delayed subframe block fires first", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      let currentUrl = "https://attacker.example.com/page";
      const click = vi.fn(async () => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener(subframe);
          }
        }, 10);
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:8080/internal";
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

      const subframeBlocked = new Error("subframe blocked");
      const mainFrameBlocked = new Error("main frame blocked");
      getPwToolsCoreNavigationGuardMocks()
        .assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(subframeBlocked);
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        mainFrameBlocked,
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("main frame blocked");

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(230);
      await rejection;
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

  it("does not stop watching for a later main-frame navigation after a harmless subframe hop", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "about:blank" };
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

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(230);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://127.0.0.1:9222/json/list",
      });
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

  it("checks delayed subframe navigations in the action-error recovery path", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      const page = {
        mainFrame: vi.fn(() => mainFrame),
        evaluate: vi.fn(async () => {
          setTimeout(() => {
            for (const listener of listeners) {
              listener(subframe);
            }
          }, 10);
          throw new Error("evaluate failed");
        }),
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
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("SSRF blocked: private network");
      getPwToolsCoreNavigationGuardMocks()
        .assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(blocked);

      const task = mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        fn: "() => 1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("SSRF blocked: private network");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(1);
      expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        {
          cdpUrl: "http://127.0.0.1:18792",
          page,
          response: null,
          ssrfPolicy: { allowPrivateNetwork: false },
          targetId: "T1",
        },
      );
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mock
          .invocationCallOrder[0],
      ).toBeLessThan(page.evaluate.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("snapshots subframe URLs observed during the action before they change", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = createMutableFrame("http://169.254.169.254/latest/meta-data/");
      const click = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              for (const listener of listeners) {
                listener(subframe.frame);
              }
            }, 10);
            setTimeout(() => {
              subframe.setUrl("https://example.com/embed");
            }, 20);
            setTimeout(resolve, 30);
          }),
      );
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
        url: vi.fn(() => "https://attacker.example.com/page"),
      };
      setPwToolsCoreCurrentRefLocator({ click });
      setPwToolsCoreCurrentPage(page);

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(250);
      await task;

      expect(
        getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed,
      ).toHaveBeenCalledWith({
        ssrfPolicy: { allowPrivateNetwork: false },
        url: "http://169.254.169.254/latest/meta-data/",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still quarantines the main frame when an in-flight subframe block fires first", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<(frame: object) => void>();
      const mainFrame = {};
      const subframe = { url: () => "http://169.254.169.254/latest/meta-data/" };
      let currentUrl = "https://attacker.example.com/page";
      const click = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              for (const listener of listeners) {
                listener(subframe);
              }
            }, 10);
            setTimeout(() => {
              currentUrl = "http://127.0.0.1:8080/internal";
              for (const listener of listeners) {
                listener(mainFrame);
              }
            }, 20);
            setTimeout(resolve, 30);
          }),
      );
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

      const subframeBlocked = new Error("subframe blocked");
      const mainFrameBlocked = new Error("main frame blocked");
      getPwToolsCoreNavigationGuardMocks()
        .assertBrowserNavigationResultAllowed.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(subframeBlocked);
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        mainFrameBlocked,
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("main frame blocked");

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(250);
      await rejection;
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

  it("keeps concurrent interaction guards independently owned", async () => {
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

      const first = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(1);

      const second = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(listeners.size).toBe(2);

      currentUrl = "http://127.0.0.1:9222/json/list";
      for (const listener of Array.from(listeners)) {
        listener();
      }
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([first, second]);

      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(2);
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates blocked delayed navigation instead of reporting click success", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const click = vi.fn(async () => {
        setTimeout(() => {
          currentUrl = "http://127.0.0.1:9222/private-target";
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

      const blocked = new Error("blocked delayed interaction navigation");
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("blocked delayed interaction navigation");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the post-click navigation guard with the resolved SSRF policy", async () => {
    let currentUrl = "http://127.0.0.1:9222/json/version";
    const click = vi.fn(async () => {
      currentUrl = "http://127.0.0.1:9222/json/list";
    });
    const page = { url: vi.fn(() => currentUrl) };
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
    let currentUrl = "http://127.0.0.1:9222/json/version";
    const page = {
      evaluate: vi.fn(async () => {
        currentUrl = "http://127.0.0.1:9222/json/list";
        return "ok";
      }),
      url: vi.fn(() => currentUrl),
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

  it("runs statement-body page evaluate sources", async () => {
    const page = {
      evaluate: vi.fn(async (evaluateFn: (args: unknown) => unknown, args: unknown) =>
        evaluateFn(args),
      ),
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    setPwToolsCoreCurrentPage(page);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      fn: "const value = 41; return value + 1;",
    });

    expect(result).toBe(42);
    expect(page.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async () => {\nconst value = 41; return value + 1;\n}",
    });
  });

  it("runs statement-body ref evaluate sources", async () => {
    const page = {
      url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
    };
    const locator = {
      evaluate: vi.fn(async (evaluateFn: (el: Element, args: unknown) => unknown, args: unknown) =>
        evaluateFn({ textContent: "Ada" } as Element, args),
      ),
    };
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator(locator);

    const result = await mod.evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      fn: "const text = el.textContent; return text;",
    });

    expect(result).toBe("Ada");
    expect(locator.evaluate.mock.calls[0]?.[1]).toMatchObject({
      fnSource: "async (el) => {\nconst text = el.textContent; return text;\n}",
    });
  });

  it("runs the post-keypress navigation guard when navigation starts shortly after the keypress resolves", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "http://127.0.0.1:9222/json/version";
      const page = {
        keyboard: {
          press: vi.fn(async () => {
            setTimeout(() => {
              currentUrl = "http://127.0.0.1:9222/private-target";
              for (const listener of listeners) {
                listener();
              }
            }, 10);
          }),
        },
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

      const task = mod.pressKeyViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        key: "Enter",
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
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

  it("defaults non-finite keypress delays before calling Playwright", async () => {
    vi.useFakeTimers();
    try {
      const press = vi.fn(async () => {});
      const page = {
        keyboard: { press },
        on: vi.fn(),
        off: vi.fn(),
        url: vi.fn(() => "http://127.0.0.1:9222/json/version"),
      };
      setPwToolsCoreCurrentPage(page);

      const task = mod.pressKeyViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        key: "Enter",
        delayMs: Number.NaN,
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      await vi.advanceTimersByTimeAsync(250);
      await task;

      expect(press).toHaveBeenCalledWith("Enter", { delay: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates blocked delayed submit navigation instead of reporting type success", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      let currentUrl = "https://example.com/form";
      const locator = {
        fill: vi.fn(async () => {}),
        press: vi.fn(async () => {
          setTimeout(() => {
            currentUrl = "http://127.0.0.1:9222/private-target";
            for (const listener of listeners) {
              listener();
            }
          }, 10);
        }),
      };
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
      setPwToolsCoreCurrentRefLocator(locator);
      setPwToolsCoreCurrentPage(page);

      const blocked = new Error("blocked delayed interaction navigation");
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mockRejectedValueOnce(
        blocked,
      );

      const task = mod.typeViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        text: "hello",
        submit: true,
        ssrfPolicy: { allowPrivateNetwork: false },
      });
      const rejection = expect(task).rejects.toThrow("blocked delayed interaction navigation");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(240);
      await rejection;
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
    let currentUrl = "https://example.com/page";
    const click = vi.fn(async () => {
      currentUrl = "https://example.com/page#section";
    });
    const page = { url: vi.fn(() => currentUrl) };
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

  it("checks the current page before evaluate and skips the post-evaluate guard when the url is unchanged", async () => {
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
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledTimes(
      1,
    );
    expect(getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: false },
      targetId: "T1",
    });
    expect(
      getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely.mock.invocationCallOrder[0],
    ).toBeLessThan(page.evaluate.mock.invocationCallOrder[0]);
  });

  it("propagates the SSRF policy through batch interaction actions", async () => {
    let currentUrl = "about:blank";
    const click = vi.fn(async () => {
      currentUrl = "https://example.com/after";
    });
    const page = { url: vi.fn(() => currentUrl) };
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
      getPwToolsCoreSessionMocks()
        .assertPageNavigationCompletedSafely.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(blocked);

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

  it("returns click downloads without adding a second policy grace", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const click = vi.fn(async () => {});
    const drain = vi.fn(async () => [
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose,
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ click });

    const result = await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "click", ref: "1" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    expect(result.downloads).toEqual([
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 0,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage).toHaveBeenCalledWith(
      page,
      { beforeSave: expect.any(Function) },
    );
  });

  it("rechecks the owning page before saving an action-triggered data download", async () => {
    let currentUrl = "https://safe.example/start";
    const privateUrl = "http://169.254.169.254/latest/meta-data/";
    const page = { url: vi.fn(() => currentUrl) };
    const click = vi.fn(async () => {});
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain: vi.fn(async () => undefined),
      dispose: vi.fn(),
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ click });

    await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "click", ref: "1" },
      ssrfPolicy: { allowPrivateNetwork: false },
    });

    const captureOptions = getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mock
      .calls[0]?.[1] as { beforeSave?: (download: { url: string }) => Promise<void> } | undefined;
    const beforeSave = captureOptions?.beforeSave;
    if (!beforeSave) {
      throw new Error("expected action download policy callback");
    }
    const blocked = new Error("blocked private action download owner");
    currentUrl = privateUrl;
    getPwToolsCoreNavigationGuardMocks().assertBrowserNavigationResultAllowed.mockImplementation(
      async ({ url }: { url: string }) => {
        if (url === privateUrl) {
          throw blocked;
        }
      },
    );

    await expect(beforeSave({ url: "data:text/plain,private" })).rejects.toBe(blocked);
  });

  it.each([
    { action: { kind: "hover", ref: "1" } as const, method: "hover" },
    {
      action: { kind: "scrollIntoView", ref: "1" } as const,
      method: "scrollIntoViewIfNeeded",
    },
    {
      action: { kind: "drag", startRef: "1", endRef: "2" } as const,
      method: "dragTo",
    },
    { action: { kind: "resize", width: 800, height: 600 } as const, method: "setViewportSize" },
  ])(
    "uses the navigation guard window instead of duplicate download grace for $method",
    async ({ action, method }) => {
      const page = {
        setViewportSize: vi.fn(async () => {}),
        url: vi.fn(() => "https://example.com"),
      };
      const locator = {
        hover: vi.fn(async () => {}),
        scrollIntoViewIfNeeded: vi.fn(async () => {}),
        dragTo: vi.fn(async () => {}),
      };
      const drain = vi.fn(async () => undefined);
      getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
        drain,
        dispose: vi.fn(),
      });
      setPwToolsCoreCurrentPage(page);
      setPwToolsCoreCurrentRefLocator(locator);

      await mod.executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        action,
        ssrfPolicy: { allowPrivateNetwork: false },
      });

      const invoked =
        method === "setViewportSize"
          ? page.setViewportSize
          : locator[method as keyof typeof locator];
      expect(invoked).toHaveBeenCalledTimes(1);
      expect(drain).toHaveBeenCalledWith({
        firstEventGraceMs: 0,
        maxWaitMs: 1_000,
        quietMs: 250,
      });
    },
  );

  it.each([
    { action: { kind: "hover", ref: "1" } as const, method: "hover" },
    {
      action: { kind: "scrollIntoView", ref: "1" } as const,
      method: "scrollIntoViewIfNeeded",
    },
    {
      action: { kind: "drag", startRef: "1", endRef: "2" } as const,
      method: "dragTo",
    },
    { action: { kind: "resize", width: 800, height: 600 } as const, method: "setViewportSize" },
  ])("retains download event grace for policy-free $method", async ({ action, method }) => {
    const page = {
      setViewportSize: vi.fn(async () => {}),
      url: vi.fn(() => "https://example.com"),
    };
    const locator = {
      hover: vi.fn(async () => {}),
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      dragTo: vi.fn(async () => {}),
    };
    const drain = vi.fn(async () => undefined);
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose: vi.fn(),
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator(locator);

    await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action,
    });

    const invoked =
      method === "setViewportSize" ? page.setViewportSize : locator[method as keyof typeof locator];
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 250,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
  });

  it("quarantines the target without closing it when an action download fails policy", async () => {
    const page = { url: vi.fn(() => "https://example.com") };
    const click = vi.fn(async () => {});
    const blocked = new Error("blocked action download");
    blocked.name = "InvalidBrowserNavigationUrlError";
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain: vi.fn(async () => {
        throw blocked;
      }),
      dispose,
    });
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ click });

    await expect(
      mod.executeActViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        action: { kind: "click", ref: "1" },
      }),
    ).rejects.toBe(blocked);

    expect(
      getPwToolsCoreSessionMocks().quarantineBlockedNavigationTargetForError,
    ).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      error: blocked,
      page,
      targetId: "T1",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("captures key-triggered downloads with a bounded event grace", async () => {
    const page = {
      keyboard: { press: vi.fn(async () => {}) },
      url: vi.fn(() => "https://example.com"),
    };
    const drain = vi.fn(async () => [
      {
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ]);
    const dispose = vi.fn();
    getPwToolsCoreSessionMocks().beginActionDownloadCaptureOnPage.mockReturnValueOnce({
      drain,
      dispose,
    });
    setPwToolsCoreCurrentPage(page);

    const result = await mod.executeActViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      action: { kind: "press", key: "Enter" },
    });

    expect(result.downloads).toEqual([
      expect.objectContaining({ suggestedFilename: "report.pdf" }),
    ]);
    expect(drain).toHaveBeenCalledWith({
      firstEventGraceMs: 250,
      maxWaitMs: 1_000,
      quietMs: 250,
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
