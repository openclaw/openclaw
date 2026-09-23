import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CDPSession } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_REF_MARKER_ATTRIBUTE,
  markBackendDomRefsOnPage,
  readMainFrameDocumentIdentityForPage,
  withPageScopedCdpClient,
  withCdpSnapshotRoot,
} from "./pw-session.page-cdp.js";

describe("pw-session page-scoped CDP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "before-clear",
    "after-document",
    "after-resolve",
    "after-clear",
    "after-nodes",
    "after-write",
  ])("stops marker writes when capture authority ends %s", async (stage) => {
    const controller = new AbortController();
    const reason = new Error("capture ended");
    const writes: number[] = [];
    let cleared = false;
    let released = false;
    const send = vi.fn(async (method: string, params?: { nodeId?: number }) => {
      if (method === "DOM.getDocument") {
        if (stage === "after-document") {
          controller.abort(reason);
        }
        return { root: { backendNodeId: 1 } };
      }
      if (method === "DOM.resolveNode") {
        if (stage === "after-resolve") {
          controller.abort(reason);
        }
        return { object: { objectId: "document" } };
      }
      if (method === "Runtime.callFunctionOn") {
        cleared = true;
        if (stage === "after-clear") {
          controller.abort(reason);
        }
      }
      if (method === "Runtime.releaseObject") {
        released = true;
      }
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        if (stage === "after-nodes") {
          controller.abort(reason);
        }
        return { nodeIds: [101, 202] };
      }
      if (method === "DOM.setAttributeValue") {
        writes.push(params!.nodeId!);
        if (stage === "after-write") {
          controller.abort(reason);
        }
      }
      return {};
    });
    const page = {
      context: () => ({ newCDPSession: async () => ({ send, detach: async () => {} }) }),
    };
    if (stage === "before-clear") {
      controller.abort(reason);
    }
    await expect(
      markBackendDomRefsOnPage({
        page: page as never,
        refs: [
          { ref: "e1", backendDOMNodeId: 42 },
          { ref: "e2", backendDOMNodeId: 84 },
        ],
        assertCurrent: () => controller.signal.throwIfAborted(),
      }),
    ).rejects.toBe(reason);
    expect(cleared).toBe(["after-clear", "after-nodes", "after-write"].includes(stage));
    expect(released).toBe(!["before-clear", "after-document"].includes(stage));
    expect(writes).toEqual(stage === "after-write" ? [101] : []);
  });

  it("clears a root marker when its injection reply rejects after mutation", async () => {
    let markerInstalled = false;
    const root = {
      evaluate: vi
        .fn()
        .mockImplementationOnce(async () => {
          markerInstalled = true;
          throw new Error("Injection reply lost");
        })
        .mockImplementationOnce(async () => {
          markerInstalled = false;
        }),
    };
    const send = vi.fn();
    const run = vi.fn();
    await expect(withCdpSnapshotRoot({ root: root as never, send, run })).rejects.toThrow(
      "Injection reply lost",
    );
    expect(markerInstalled).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("uses Playwright page sessions", async () => {
    const sessionDetach = vi.fn(async () => {});
    const session = {
      send: vi.fn(async function (this: unknown) {
        expect(this).toBe(session);
        return { ok: true };
      }),
      detach: sessionDetach,
    };
    const newCDPSession = vi.fn(async () => session);
    const page = {
      context: () => ({
        newCDPSession,
      }),
    };

    await withPageScopedCdpClient({
      page: page as never,
      fn: async (pageSend) => {
        await pageSend("Emulation.setLocaleOverride", { locale: "en-US" });
      },
    });

    expect(newCDPSession).toHaveBeenCalledWith(page);
    expect(session.send).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "en-US" });
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("reads the main-frame loader identity through the existing page session", async () => {
    const sessionSend = vi.fn(async (method: string) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { loaderId: "LOADER_SAME_URL" } } }
        : {},
    );
    const sessionDetach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: sessionSend, detach: sessionDetach })),
      }),
    };

    await expect(readMainFrameDocumentIdentityForPage(page as never)).resolves.toBe(
      "cdp:LOADER_SAME_URL",
    );
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it.each(["attach", "command", "detach"] as const)(
    "bounds page CDP %s and releases its exact session",
    async (phase) => {
      vi.useFakeTimers();
      const gate = createDeferred<void>();
      const session = {
        send: vi.fn(async () => {
          if (phase === "command") {
            await gate.promise;
          }
          return {};
        }),
        detach: vi.fn(async () => {
          if (phase === "detach") {
            await gate.promise;
          }
        }),
      };
      const page = {
        context: () => ({
          newCDPSession: async () => {
            if (phase === "attach") {
              await gate.promise;
            }
            return session;
          },
        }),
      };
      const action = vi.fn(async (send: CDPSession["send"]) => {
        await send("Page.getFrameTree");
      });
      let failure: unknown;
      const operation = withPageScopedCdpClient({
        page: page as never,
        timeoutMs: 50,
        fn: action,
      }).catch((error: unknown) => {
        failure = error;
      });
      try {
        await vi.advanceTimersByTimeAsync(50);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("timed out");
      } finally {
        gate.resolve();
        await operation;
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
      expect(session.detach).toHaveBeenCalledOnce();
      if (phase === "attach") {
        expect(action).not.toHaveBeenCalled();
      }
    },
  );

  it("bounds main-frame identity reads by default", async () => {
    vi.useFakeTimers();
    const gate = createDeferred<void>();
    const detach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: async () => ({
          send: async () => {
            await gate.promise;
            return {};
          },
          detach,
        }),
      }),
    };
    const identity = readMainFrameDocumentIdentityForPage(page as never);
    const rejected = expect(identity).rejects.toThrow("timed out after 5000ms");
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(detach).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("requests the document before marking backend DOM refs on the page", async () => {
    let documentRequested = false;
    const sessionSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.getDocument") {
        documentRequested = true;
        return { root: { backendNodeId: 1 } };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "document" } };
      }
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        if (!documentRequested) {
          throw new Error("Document needs to be requested first");
        }
        expect(params).toEqual({ backendNodeIds: [42, 84] });
        return { nodeIds: [101, 202] };
      }
      return {};
    });
    const sessionDetach = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    }));
    const page = {
      context: () => ({ newCDPSession }),
    };

    const marked = await markBackendDomRefsOnPage({
      assertCurrent: () => {},
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(marked).toEqual(new Set(["ax1", "ax2"]));
    expect(sessionSend).toHaveBeenNthCalledWith(1, "DOM.getDocument", { depth: 0 });
    expect(sessionSend).toHaveBeenCalledWith("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [42, 84],
    });
    expect(sessionSend).toHaveBeenCalledWith("DOM.setAttributeValue", {
      nodeId: 101,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax1",
    });
    expect(sessionSend).toHaveBeenCalledWith("DOM.setAttributeValue", {
      nodeId: 202,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax2",
    });
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("marks both generated role refs and raw accessibility refs", async () => {
    const sessionSend = vi.fn(async (method: string) => {
      if (method === "DOM.getDocument") {
        return { root: { backendNodeId: 1 } };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "document" } };
      }
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        return { nodeIds: [101, 202] };
      }
      return {};
    });
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({
          send: sessionSend,
          detach: vi.fn(async () => {}),
        })),
      }),
    };

    const marked = await markBackendDomRefsOnPage({
      assertCurrent: () => {},
      page: page as never,
      refs: [
        { ref: "e1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(marked).toEqual(new Set(["e1", "ax2"]));
  });

  it("clears stale markers even when no backend refs are valid", async () => {
    const calls = vi.fn();
    const send: CDPSession["send"] = async (method, params) => {
      calls(method, params);
      const response = responses[method];
      if (response === undefined) {
        throw new Error(`Unexpected CDP command: ${method}`);
      }
      return response;
    };
    const responses: {
      [Method in Parameters<CDPSession["send"]>[0]]?: Awaited<ReturnType<typeof send<Method>>>;
    } = {
      "DOM.getDocument": {
        root: {
          nodeId: 1,
          backendNodeId: 1,
          nodeType: 9,
          nodeName: "#document",
          localName: "",
          nodeValue: "",
        },
      },
      "DOM.resolveNode": { object: { type: "object", objectId: "document" } },
      "Runtime.callFunctionOn": { result: { type: "undefined" } },
      "Runtime.releaseObject": {},
    };
    const marked = await markBackendDomRefsOnPage({
      assertCurrent: () => {},
      page: {} as never,
      send,
      refs: [{ ref: "e1", backendDOMNodeId: 0 }],
    });
    expect(calls).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "document",
        arguments: [{ value: BROWSER_REF_MARKER_ATTRIBUTE }],
      }),
    );
    expect(calls).not.toHaveBeenCalledWith(
      "DOM.pushNodesByBackendIdsToFrontend",
      expect.anything(),
    );
    expect(marked).toEqual(new Set());
  });

  it("keeps unmarked refs out of the marked set when marker writes fail", async () => {
    const sessionSend = vi.fn(async (method: string) => {
      if (method === "DOM.getDocument") {
        return { root: { backendNodeId: 1 } };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "document" } };
      }
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        return { nodeIds: [101, 202] };
      }
      if (method === "DOM.setAttributeValue") {
        throw new Error("detached");
      }
      return {};
    });
    const sessionDetach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({
          send: sessionSend,
          detach: sessionDetach,
        })),
      }),
    };

    const marked = await markBackendDomRefsOnPage({
      assertCurrent: () => {},
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(marked).toEqual(new Set());
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });
});
