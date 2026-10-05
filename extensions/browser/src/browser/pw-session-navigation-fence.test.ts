import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as navigationGuard from "./navigation-guard.js";
import { installNavigationAuthorityFence } from "./pw-session-navigation-fence.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("navigation authority fence lifecycle", () => {
  it("keeps a pending document redirect fenced after its initiating action returns", async () => {
    vi.spyOn(navigationGuard, "assertBrowserNavigationAllowed").mockResolvedValue(undefined);
    const send = vi.fn(async () => {});
    const detach = vi.fn(async () => {});
    const session = Object.assign(new EventEmitter(), { send, detach });
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => session }),
      isClosed: () => false,
    });
    const dispose = await installNavigationAuthorityFence(
      page as unknown as Page,
      { assertNavigationCurrent: () => {} },
      () => {},
    );
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

  it("removes the paused-request listener before detachment releases interception", async () => {
    const errors: unknown[] = [];
    let detached = false;
    const send = vi.fn(async () => {
      if (detached) {
        throw new Error("Invalid InterceptionId");
      }
    });
    const session = Object.assign(new EventEmitter(), {
      send,
      detach: vi.fn(async () => {
        detached = true;
        session.emit("Fetch.requestPaused", {
          requestId: "late-resource",
          resourceType: "Other",
          request: { url: "https://example.com/favicon.ico" },
        });
      }),
    });
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => session }),
      isClosed: () => false,
    }) as unknown as Page;
    const dispose = await installNavigationAuthorityFence(
      page,
      { assertNavigationCurrent: () => {} },
      (error) => errors.push(error),
    );
    expect(await dispose()).toBeUndefined();
    expect(errors).toEqual([]);
    expect(session.listenerCount("Fetch.requestPaused")).toBe(0);
  });

  it("retains interception until target close when revoked loading cannot be stopped", async () => {
    const denied = Promise.withResolvers<void>();
    const stopError = new Error("stop acknowledgement unavailable");
    const send = vi.fn(async (method: string) => {
      if (method === "Page.stopLoading") {
        throw stopError;
      }
      if (method === "Fetch.failRequest") {
        denied.resolve();
      }
    });
    const detach = vi.fn(async () => {});
    const session = Object.assign(new EventEmitter(), { send, detach });
    let closed = false;
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => session }),
      isClosed: () => closed,
    });
    let current = true;
    const dispose = await installNavigationAuthorityFence(
      page as unknown as Page,
      {
        assertNavigationCurrent: () => {
          if (!current) {
            throw new Error("invocation revoked");
          }
        },
      },
      () => {},
    );
    current = false;
    expect(await dispose()).toBe(stopError);
    expect(detach).not.toHaveBeenCalled();
    session.emit("Fetch.requestPaused", {
      requestId: "late-redirect",
      resourceType: "Document",
      request: { url: "http://127.0.0.1/target" },
    });
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
    const send = vi.fn(async () => {});
    const detach = vi.fn(async () => {});
    const session = Object.assign(new EventEmitter(), { send, detach });
    let closed = false;
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => session }),
      isClosed: () => closed,
    });
    const errors: unknown[] = [];
    const dispose = await installNavigationAuthorityFence(
      page as unknown as Page,
      { assertNavigationCurrent: () => {} },
      (error) => errors.push(error),
    );
    session.emit("Fetch.requestPaused", {
      requestId: "stalled-policy",
      resourceType: "Document",
      request: { url: "http://127.0.0.1/target" },
    });
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
      session.emit("Fetch.requestPaused", {
        requestId: "late-redirect",
        resourceType: "Document",
        request: { url: "http://127.0.0.1/late" },
      });
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
      const send = vi.fn(async (method: string) => {
        if (method === "Fetch.failRequest" || method === "Fetch.continueRequest") {
          stopped.resolve();
        }
      });
      const detach = vi.fn(async () => {});
      const session = Object.assign(new EventEmitter(), { send, detach });
      const page = Object.assign(new EventEmitter(), {
        context: () => ({ newCDPSession: async () => session }),
        isClosed: () => false,
      }) as unknown as Page;
      let current = true;
      const errors: unknown[] = [];
      const dispose = await installNavigationAuthorityFence(
        page,
        {
          assertNavigationCurrent: () => {
            if (!current) {
              throw new Error("invocation revoked");
            }
          },
        },
        (error) => errors.push(error),
      );
      session.emit("Fetch.requestPaused", {
        requestId: "redirect-hop",
        resourceType: "Document",
        request: { url: "http://127.0.0.1/target" },
      });
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
