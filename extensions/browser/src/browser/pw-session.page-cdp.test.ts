// Browser tests cover pw session.page cdp plugin behavior.
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_REF_MARKER_ATTRIBUTE,
  markBackendDomRefsOnPage,
  readMainFrameDocumentIdentityForPage,
  withPageScopedCdpClient,
} from "./pw-session.page-cdp.js";

describe("pw-session page-scoped CDP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Playwright page sessions", async () => {
    const sessionSend = vi.fn(async () => ({ ok: true }));
    const sessionDetach = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    }));
    const page = {
      context: () => ({
        newCDPSession,
      }),
    };

    await withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: page as never,
      targetId: "tab-1",
      fn: async (pageSend) => {
        await pageSend("Emulation.setLocaleOverride", { locale: "en-US" });
      },
    });

    expect(newCDPSession).toHaveBeenCalledWith(page);
    expect(sessionSend).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "en-US" });
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

  it("marks backend DOM refs on the page", async () => {
    const sessionSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
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
      context: () => ({
        newCDPSession,
      }),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(sessionSend).toHaveBeenNthCalledWith(
      1,
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining(BROWSER_REF_MARKER_ATTRIBUTE),
        returnByValue: true,
      }),
    );
    expect(sessionSend).toHaveBeenNthCalledWith(2, "DOM.enable", undefined);
    expect(sessionSend).toHaveBeenNthCalledWith(3, "DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [42, 84],
    });
    expect(sessionSend).toHaveBeenNthCalledWith(4, "DOM.setAttributeValue", {
      nodeId: 101,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax1",
    });
    expect(sessionSend).toHaveBeenNthCalledWith(5, "DOM.setAttributeValue", {
      nodeId: 202,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax2",
    });
    expect(marked).toEqual(new Set(["ax1", "ax2"]));
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("clears stale markers even when no backend refs are valid", async () => {
    const sessionSend = vi.fn(async () => ({}));
    const sessionDetach = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => ({ send: sessionSend, detach: sessionDetach }));
    const page = {
      context: () => ({
        newCDPSession,
      }),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [{ ref: "e1", backendDOMNodeId: 0 }],
    });

    expect(newCDPSession).toHaveBeenCalledOnce();
    expect(sessionSend).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining(BROWSER_REF_MARKER_ATTRIBUTE),
      }),
    );
    expect(sessionDetach).toHaveBeenCalledOnce();
    expect(marked).toEqual(new Set());
  });

  it("clears a previous snapshot marker inside an open shadow root", async () => {
    type FakeElement = {
      attributes: Map<string, string>;
      removeAttribute: ReturnType<typeof vi.fn>;
      shadowRoot?: FakeRoot;
    };
    type FakeRoot = {
      querySelectorAll: (selector: string) => FakeElement[];
    };
    const createElement = (): FakeElement => {
      const attributes = new Map<string, string>();
      return {
        attributes,
        removeAttribute: vi.fn((name: string) => attributes.delete(name)),
      };
    };
    const createRoot = (elements: FakeElement[]): FakeRoot => ({
      querySelectorAll: (selector: string) =>
        selector === "*"
          ? elements
          : elements.filter((element) => element.attributes.has(BROWSER_REF_MARKER_ATTRIBUTE)),
    });
    const staleShadowElement = createElement();
    const shadowRoot = createRoot([staleShadowElement]);
    const shadowHost = { ...createElement(), shadowRoot };
    const currentLightElement = createElement();
    const documentRoot = createRoot([shadowHost, currentLightElement]);
    const elementByNodeId = new Map([
      [101, staleShadowElement],
      [202, currentLightElement],
    ]);
    let snapshotIndex = 0;
    const sessionSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        vm.runInNewContext(String(params?.expression), { document: documentRoot });
      }
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        snapshotIndex += 1;
        return { nodeIds: [snapshotIndex === 1 ? 101 : 202] };
      }
      if (method === "DOM.setAttributeValue") {
        const element = elementByNodeId.get(Number(params?.nodeId));
        element?.attributes.set(String(params?.name), String(params?.value));
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

    await markBackendDomRefsOnPage({
      page: page as never,
      refs: [{ ref: "ax1", backendDOMNodeId: 42 }],
    });
    expect(staleShadowElement.attributes.get(BROWSER_REF_MARKER_ATTRIBUTE)).toBe("ax1");

    await markBackendDomRefsOnPage({
      page: page as never,
      refs: [{ ref: "ax1", backendDOMNodeId: 84 }],
    });

    expect(staleShadowElement.attributes.has(BROWSER_REF_MARKER_ATTRIBUTE)).toBe(false);
    expect(staleShadowElement.removeAttribute).toHaveBeenCalledWith(BROWSER_REF_MARKER_ATTRIBUTE);
    expect(currentLightElement.attributes.get(BROWSER_REF_MARKER_ATTRIBUTE)).toBe("ax1");
  });

  it("stops after marker cleanup when publication is aborted", async () => {
    const controller = new AbortController();
    const cancellation = new Error("marker publication cancelled");
    const sessionDetach = vi.fn(async () => {});
    const sessionSend = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") {
        controller.abort(cancellation);
      }
      return {};
    });
    const newCDPSession = vi.fn(async () => ({ send: sessionSend, detach: sessionDetach }));
    const page = {
      context: () => ({ newCDPSession }),
    };

    await expect(
      markBackendDomRefsOnPage({
        page: page as never,
        refs: [{ ref: "ax1", backendDOMNodeId: 42 }],
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(sessionSend).toHaveBeenCalledTimes(1);
    expect(sessionSend).not.toHaveBeenCalledWith("DOM.enable", undefined);
    expect(sessionDetach).toHaveBeenCalledOnce();
  });

  it("does not swallow cancellation between marker writes", async () => {
    const controller = new AbortController();
    const cancellation = new Error("marker write cancelled");
    const sessionSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        return { nodeIds: [101, 202] };
      }
      if (method === "DOM.setAttributeValue" && params?.value === "ax1") {
        controller.abort(cancellation);
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

    await expect(
      markBackendDomRefsOnPage({
        page: page as never,
        refs: [
          { ref: "ax1", backendDOMNodeId: 42 },
          { ref: "ax2", backendDOMNodeId: 84 },
        ],
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(sessionSend).toHaveBeenCalledWith(
      "DOM.setAttributeValue",
      expect.objectContaining({ value: "ax1" }),
    );
    expect(sessionSend).not.toHaveBeenCalledWith(
      "DOM.setAttributeValue",
      expect.objectContaining({ value: "ax2" }),
    );
  });

  it("keeps unmarked refs out of the marked set when marker writes fail", async () => {
    const sessionSend = vi.fn(async (method: string) => {
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
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(marked).toEqual(new Set());
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("detaches an aborted page session without disrupting a sibling page session", async () => {
    const firstController = new AbortController();
    const cancellation = new Error("first page probe timed out");
    const firstDetach = vi.fn(async () => {});
    const firstSend = vi.fn(
      async () =>
        await new Promise<never>(() => {
          // Intentionally never settles; abort must retire only this page session.
        }),
    );
    const secondDetach = vi.fn(async () => {});
    const secondSend = vi.fn(async () => ({ ok: true }));
    const firstPage = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: firstSend, detach: firstDetach })),
      }),
    };
    const secondPage = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: secondSend, detach: secondDetach })),
      }),
    };

    const first = withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: firstPage as never,
      targetId: "tab-1",
      signal: firstController.signal,
      fn: async (send) => await send("Accessibility.enable"),
    });
    void first.catch(() => {});
    await vi.waitFor(() => expect(firstSend).toHaveBeenCalledOnce());
    firstController.abort(cancellation);

    await expect(first).rejects.toBe(cancellation);
    await expect(
      withPageScopedCdpClient({
        cdpUrl: "http://127.0.0.1:9222",
        page: secondPage as never,
        targetId: "tab-2",
        fn: async (send) => await send("Runtime.evaluate", { expression: "document.title" }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(firstDetach).toHaveBeenCalledOnce();
    expect(secondSend).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "document.title",
    });
    expect(secondDetach).toHaveBeenCalledOnce();
  });
});
