import { EventEmitter } from "node:events";
import { setImmediate as nextTick } from "node:timers/promises";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as navigationGuard from "./navigation-guard.js";
import { installNavigationAuthorityFence } from "./pw-session-navigation-fence.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fence(
  options: {
    send?: (method: string) => Promise<unknown>;
    detach?: () => Promise<void>;
    isClosed?: () => boolean;
    assertCurrent?: () => void;
    standingSsrfPolicy?: SsrFPolicy;
    handleDocument?: Parameters<typeof installNavigationAuthorityFence>[3];
  } = {},
) {
  const send = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "MAIN_FRAME" } } };
    }
    return await options.send?.(method);
  });
  const detach = vi.fn(options.detach ?? (async () => {}));
  const session = Object.assign(new EventEmitter(), {
    send: async (method: string, params?: unknown) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : send(method, params),
    detach,
  });
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: async () => session }),
    isClosed: options.isClosed ?? (() => false),
  });
  const errors: unknown[] = [];
  const dispose = await installNavigationAuthorityFence(
    page as unknown as Page,
    {
      assertNavigationCurrent: options.assertCurrent ?? (() => {}),
      standingSsrfPolicy: options.standingSsrfPolicy,
    },
    (error) => errors.push(error),
    options.handleDocument,
  );
  const pause = (requestId: string, url = "http://127.0.0.1/target") =>
    session.emit("Fetch.requestPaused", {
      requestId,
      resourceType: "Document",
      request: { url, headers: {} },
    });
  return { send, detach, session, page, errors, dispose, pause };
}

describe("navigation authority fence lifecycle", () => {
  it("observes queued document interception before an idle cleanup", async () => {
    const releaseBarrier = Promise.withResolvers<void>();
    const { send, session, dispose } = await fence({
      send: async (method) => {
        if (method === "Runtime.evaluate") {
          await releaseBarrier.promise;
        }
      },
      handleDocument: async (route) => {
        await route.preserve();
      },
    });
    const cleanup = dispose();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Runtime.evaluate", { expression: "void 0" }),
    );
    session.emit("Network.requestWillBeSent", {
      requestId: "document",
      type: "Document",
      frameId: "MAIN_FRAME",
    });
    session.emit("Fetch.requestPaused", {
      requestId: "interception",
      networkId: "document",
      frameId: "MAIN_FRAME",
      resourceType: "Document",
      request: { url: "http://127.0.0.1/blocked" },
    });
    releaseBarrier.resolve();
    await expect(cleanup).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith("Fetch.failRequest", {
      requestId: "interception",
      errorReason: "Aborted",
    });
    expect(send).not.toHaveBeenCalledWith("Fetch.disable", undefined);
  });

  it("settles a document completed by the operation-owned interceptor", async () => {
    const releaseFulfillment = Promise.withResolvers<void>();
    const { send, session, dispose } = await fence({
      send: async (method) => {
        if (method === "Fetch.failRequest") {
          await releaseFulfillment.promise;
        }
      },
      handleDocument: async (route) => {
        await route.preserve();
      },
    });
    session.emit("Network.requestWillBeSent", {
      requestId: "document",
      type: "Document",
      frameId: "MAIN_FRAME",
    });
    session.emit("Fetch.requestPaused", {
      requestId: "interception",
      frameId: "MAIN_FRAME",
      resourceType: "Document",
      request: { url: "http://127.0.0.1/blocked" },
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Fetch.failRequest", {
        requestId: "interception",
        errorReason: "Aborted",
      }),
    );
    const cleanup = dispose();
    releaseFulfillment.resolve();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("keeps a pending document redirect fenced after its initiating action returns", async () => {
    vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockResolvedValue(undefined);
    const { send, session, dispose } = await fence();
    session.emit("Network.requestWillBeSent", { requestId: "document", type: "Document" });
    let released = false;
    const cleanup = dispose().then(() => {
      released = true;
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Runtime.evaluate", { expression: "void 0" }),
    );
    expect(released).toBe(false);
    session.emit("Fetch.requestPaused", {
      requestId: "redirect",
      networkId: "document",
      resourceType: "Document",
      request: { url: "https://example.com/target" },
    });
    // Avoid DNS in this lifecycle-only proof; terminal network state owns cleanup.
    session.emit("Network.loadingFinished", { requestId: "document" });
    await cleanup;
    expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "redirect" });
    expect(send).not.toHaveBeenCalledWith("Page.stopLoading");
  });

  it("stops a timed-out committed document before waiting for cleanup", async () => {
    const { send, session, dispose } = await fence();
    session.emit("Network.requestWillBeSent", {
      requestId: "streaming-document",
      type: "Document",
      frameId: "MAIN_FRAME",
    });

    await expect(dispose({ stopLoading: true })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith("Page.stopLoading", undefined);
  });

  it("retires committed bodies while retaining a simultaneous child redirect", async () => {
    const { send, session, dispose } = await fence();
    for (const frameId of ["main", "child"]) {
      session.emit("Network.requestWillBeSent", {
        requestId: frameId + "-document",
        type: "Document",
        frameId,
      });
    }
    let released = false;
    const cleanup = dispose().then((error) => {
      released = true;
      return error;
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Runtime.evaluate", { expression: "void 0" }),
    );
    session.emit("Page.frameNavigated", { frame: { id: "main" } });
    await Promise.resolve();
    expect(released).toBe(false);
    // Neither body reaches EOF. Only the child's own commit retires its chain.
    session.emit("Page.frameNavigated", { frame: { id: "child" } });
    await expect(cleanup).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalledWith("Page.stopLoading", undefined);
  });

  it("lets documents load once the invocation releases its claim", async () => {
    const { send, detach, dispose, pause } = await fence({
      handleDocument: async (route) => {
        await route.preserve();
      },
    });
    expect(await dispose()).toBeUndefined();
    pause("unclaimed");
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "unclaimed" }),
    );
    expect(send).not.toHaveBeenCalledWith("Fetch.failRequest", expect.anything());
    expect(detach).not.toHaveBeenCalled();
  });

  it("returns the tab to its standing policy when the invocation releases its claim", async () => {
    const { send, dispose, pause } = await fence({
      standingSsrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      handleDocument: async (route) => {
        await route.continue();
      },
    });
    pause("granted", "http://127.0.0.1/during");
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "granted" }),
    );
    expect(await dispose()).toBeUndefined();
    pause("private", "http://127.0.0.1/after");
    pause("public", "http://93.184.216.34/after");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith("Fetch.failRequest", {
        requestId: "private",
        errorReason: "BlockedByClient",
      });
      expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "public" });
    });
  });

  it("starts the next invocation's document tracking after the last release is acknowledged", async () => {
    // A transport that applies the release when it answers it.
    const disabled = Promise.withResolvers<void>();
    let releasing = false;
    let tracking = false;
    const { send, page, dispose } = await fence({
      send: async (method) => {
        if (method === "Network.enable") {
          tracking = true;
        }
        if (method === "Network.disable") {
          releasing = true;
          await disabled.promise;
          tracking = false;
        }
      },
    });
    let returned = false;
    const released = dispose().finally(() => {
      returned = true;
    });
    await vi.waitFor(() => expect(releasing).toBe(true));
    const next = installNavigationAuthorityFence(page as unknown as Page, {}, () => {});
    await nextTick();
    const returnedBeforeAcknowledged = returned;
    disabled.resolve();
    expect(await released).toBeUndefined();
    await next;
    expect({ returnedBeforeAcknowledged, tracking }).toEqual({
      returnedBeforeAcknowledged: false,
      tracking: true,
    });
    expect(send).not.toHaveBeenCalledWith("Fetch.disable", undefined);
  });

  it("fails the next invocation when the last release is never acknowledged", async () => {
    vi.useFakeTimers();
    const { send, page, dispose } = await fence({
      send: async (method) => {
        if (method === "Network.disable") {
          await new Promise(() => {});
        }
      },
    });
    const enables = () => send.mock.calls.filter(([method]) => method === "Network.enable").length;
    const enabledBefore = enables();
    const released = dispose();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Network.disable", undefined));
    let outcome: unknown = "pending";
    void installNavigationAuthorityFence(page as unknown as Page, {}, () => {}).then(
      () => {
        outcome = "claimed";
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect({ outcome, enabledAfterRelease: enables() - enabledBefore }).toEqual({
      outcome: new Error("Browser navigation interception was not released in time"),
      enabledAfterRelease: 0,
    });
    // It started nothing, so it leaves the tab as it found it.
    expect(send).not.toHaveBeenCalledWith("Page.stopLoading", undefined);
    expect(send.mock.calls.filter(([method]) => method === "Network.disable")).toHaveLength(1);
    expect(await released).toEqual(
      new Error("Browser navigation did not settle before authority cleanup"),
    );
  });

  it("fails an invocation whose document tracking does not start", async () => {
    let refused = false;
    const { page, dispose } = await fence({
      send: async (method) => {
        if (refused && method === "Network.enable") {
          throw new Error("tracking refused");
        }
      },
    });
    expect(await dispose()).toBeUndefined();
    refused = true;
    await expect(
      installNavigationAuthorityFence(page as unknown as Page, {}, () => {}),
    ).rejects.toThrow("tracking refused");
  });

  it("retains interception until target close when revoked loading cannot be stopped", async () => {
    const denied = Promise.withResolvers<void>();
    const stopError = new Error("stop acknowledgement unavailable");
    let closed = false;
    let current = true;
    const { send, detach, session, page, dispose, pause } = await fence({
      send: async (method) => {
        if (method === "Page.stopLoading") {
          throw stopError;
        }
        if (method === "Fetch.failRequest") {
          denied.resolve();
        }
      },
      isClosed: () => closed,
      assertCurrent: () => {
        if (!current) {
          throw new Error("invocation revoked");
        }
      },
    });
    current = false;
    expect(await dispose()).toBe(stopError);
    expect(detach).not.toHaveBeenCalled();
    pause("late-redirect");
    await denied.promise;
    expect(send).not.toHaveBeenCalledWith("Fetch.continueRequest", expect.anything());
    closed = true;
    page.emit("close");
    expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("bounds disposal when an admitted policy check never settles", async () => {
    vi.useFakeTimers();
    const validation = Promise.withResolvers<void>();
    vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockReturnValue(validation.promise);
    let closed = false;
    const { send, detach, session, page, errors, dispose, pause } = await fence({
      isClosed: () => closed,
    });
    pause("stalled-policy");
    let result: unknown;
    const cleanup = dispose().then((error) => {
      result = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(result).toEqual(
        new Error("Browser navigation did not settle before authority cleanup"),
      );
      expect(detach).not.toHaveBeenCalled();
      pause("late-redirect", "http://127.0.0.1/late");
      expect(send).toHaveBeenCalledWith("Fetch.failRequest", {
        requestId: "late-redirect",
        errorReason: "Aborted",
      });
      expect(send).not.toHaveBeenCalledWith("Fetch.continueRequest", expect.anything());
      expect(errors).toContainEqual(result);
    } finally {
      closed = true;
      page.emit("close");
      validation.resolve();
      await cleanup;
    }
    expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
  });

  it("does not make a later invocation wait on a document its refused tab abandoned", async () => {
    vi.useFakeTimers();
    let closed = false;
    const { session, page, dispose } = await fence({ isClosed: () => closed });
    session.emit("Network.requestWillBeSent", {
      requestId: "never-answers",
      type: "Document",
      frameId: "MAIN_FRAME",
    });
    const abandoned = dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await abandoned).toEqual(
      new Error("Browser navigation did not settle before authority cleanup"),
    );
    const next = await installNavigationAuthorityFence(page as unknown as Page, {}, () => {});
    let result: unknown = "pending";
    void next().then((error) => {
      result = error;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    try {
      expect(result).toBeUndefined();
    } finally {
      closed = true;
      page.emit("close");
      await vi.advanceTimersByTimeAsync(20_000);
    }
  });

  it.each(["revoked", "closing"] as const)(
    "rechecks awaited policy while authority is %s",
    async (state) => {
      const entered = Promise.withResolvers<void>();
      const validation = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockImplementationOnce(
        async () => {
          entered.resolve();
          await validation.promise;
        },
      );
      let current = true;
      const { send, detach, errors, dispose, pause } = await fence({
        send: async (method) => {
          if (method === "Fetch.failRequest" || method === "Fetch.continueRequest") {
            stopped.resolve();
          }
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("invocation revoked");
          }
        },
      });
      pause("redirect-hop");
      await entered.promise;
      let cleanup: Promise<unknown> | undefined;
      if (state === "revoked") {
        current = false;
      } else {
        cleanup = dispose();
        expect(detach).not.toHaveBeenCalled();
      }
      validation.resolve();
      await stopped.promise;
      await (cleanup ?? dispose());
      if (state === "revoked") {
        expect(send).not.toHaveBeenCalledWith("Fetch.continueRequest", expect.anything());
        expect(send).toHaveBeenCalledWith("Fetch.failRequest", {
          requestId: "redirect-hop",
          errorReason: "Aborted",
        });
        expect(errors).toContainEqual(new Error("invocation revoked"));
      } else {
        expect(send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "redirect-hop" });
        expect(errors).toEqual([]);
      }
    },
  );

  describe("page-cancelled interceptions", () => {
    const stale = new Error(
      "cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.",
    );

    it.each([
      ["policy", undefined],
      ["document route", async (route: { continue: () => Promise<void> }) => route.continue()],
    ] as const)("treats a retired id on %s resume as settled", async (_owner, handleDocument) => {
      vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockResolvedValue(undefined);
      const { send, errors, dispose, pause } = await fence({
        send: async (method) => {
          if (method === "Fetch.continueRequest") {
            throw stale;
          }
        },
        handleDocument,
      });
      pause("cancelled-frame");
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith("Fetch.continueRequest", {
          requestId: "cancelled-frame",
        }),
      );
      await expect(dispose()).resolves.toBeUndefined();
      expect(errors).toEqual([]);
      expect(send).not.toHaveBeenCalledWith("Fetch.failRequest", expect.anything());
    });

    it("still reports a denied document whose id retired before cancellation", async () => {
      const denial = new Error("navigation blocked by policy");
      vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockRejectedValue(denial);
      const { send, errors, dispose, pause } = await fence({
        send: async (method) => {
          if (method === "Fetch.failRequest") {
            throw stale;
          }
        },
      });
      pause("denied-frame", "http://127.0.0.1/denied");
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith("Fetch.failRequest", {
          requestId: "denied-frame",
          errorReason: "Aborted",
        }),
      );
      await dispose();
      expect(errors).toEqual([denial]);
      expect(send).not.toHaveBeenCalledWith("Fetch.continueRequest", expect.anything());
    });

    it("surfaces other protocol failures on resume", async () => {
      vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockResolvedValue(undefined);
      const failure = new Error(
        "cdpSession.send: Protocol error (Fetch.continueRequest): Internal error",
      );
      const { send, errors, dispose, pause } = await fence({
        send: async (method) => {
          if (method === "Fetch.continueRequest") {
            throw failure;
          }
        },
      });
      pause("live-request");
      await vi.waitFor(() => expect(errors).toEqual([failure]));
      await dispose();
      expect(send).toHaveBeenCalledWith("Fetch.failRequest", {
        requestId: "live-request",
        errorReason: "Aborted",
      });
    });
  });
});
