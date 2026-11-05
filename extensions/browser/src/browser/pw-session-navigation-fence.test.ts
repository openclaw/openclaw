import { EventEmitter } from "node:events";
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
    { assertNavigationCurrent: options.assertCurrent ?? (() => {}) },
    (error) => errors.push(error),
    options.handleDocument,
  );
  const pause = (requestId: string, url = "http://127.0.0.1/target") =>
    session.emit("Fetch.requestPaused", { requestId, resourceType: "Document", request: { url } });
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
    expect(send).toHaveBeenCalledWith("Fetch.disable", undefined);
  });

  it("settles a document completed by the operation-owned interceptor", async () => {
    const releaseFulfillment = Promise.withResolvers<void>();
    const { send, detach, session, dispose } = await fence({
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
    expect(detach).toHaveBeenCalledOnce();
  });

  it("keeps a pending document redirect fenced after its initiating action returns", async () => {
    vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockResolvedValue(undefined);
    const { send, detach, session, dispose } = await fence();
    session.emit("Network.requestWillBeSent", { requestId: "document", type: "Document" });
    const cleanup = dispose();
    await Promise.resolve();
    expect(detach).not.toHaveBeenCalled();
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
    expect(detach).toHaveBeenCalledOnce();
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
    const { send, detach, session, dispose } = await fence();
    for (const frameId of ["main", "child"]) {
      session.emit("Network.requestWillBeSent", {
        requestId: frameId + "-document",
        type: "Document",
        frameId,
      });
    }
    const cleanup = dispose();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Runtime.evaluate", { expression: "void 0" }),
    );
    session.emit("Page.frameNavigated", { frame: { id: "main" } });
    await Promise.resolve();
    expect(detach).not.toHaveBeenCalled();
    // Neither body reaches EOF. Only the child's own commit retires its chain.
    session.emit("Page.frameNavigated", { frame: { id: "child" } });
    await expect(cleanup).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalledWith("Page.stopLoading", undefined);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("removes the paused-request listener before detachment releases interception", async () => {
    let detached = false;
    const { session, errors, dispose } = await fence({
      send: async () => {
        if (detached) {
          throw new Error("Invalid InterceptionId");
        }
      },
      detach: async () => {
        detached = true;
        session.emit("Fetch.requestPaused", {
          requestId: "late-resource",
          resourceType: "Other",
          request: { url: "https://example.com/favicon.ico" },
        });
      },
    });
    expect(await dispose()).toBeUndefined();
    expect(errors).toEqual([]);
    expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
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
      const { send, detach, session, errors, dispose, pause } = await fence({
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
      expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
      expect(detach).toHaveBeenCalledOnce();
    },
  );
});
