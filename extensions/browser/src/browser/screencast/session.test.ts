import { EventEmitter, getEventListeners } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachBrowserScreencastViewer, stopBrowserScreencasts } from "./session.js";
import { parseScreencastFrame, screencastParams, ScreencastViewer } from "./test-support.js";

const mocks = vi.hoisted(() => ({ getPage: vi.fn<() => Promise<Page>>() }));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({ getPageForTargetId: mocks.getPage }),
}));

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const nextUrl = "https://example.test/next";
const expectedFrame = (url = "https://example.test/") => ({
  header: { url, cssWidth: 800, cssHeight: 600, scrollX: 12, scrollY: 34, ts: 123 },
  jpeg,
});
const requesterState = () => Object.assign(new AbortController(), { invalidated: false });
const requesterParams = (requester: ReturnType<typeof requesterState>) =>
  screencastParams({
    requesterSignal: requester.signal,
    isRequesterCurrent: () => !requester.invalidated,
  });
function hold<T>(mock: { mockReturnValueOnce(value: Promise<T>): unknown }) {
  const pending = Promise.withResolvers<T>();
  mock.mockReturnValueOnce(pending.promise);
  return pending;
}
async function resume<T>(pending: { resolve(value: T): void }, value: T) {
  pending.resolve(value);
  await flush();
}

class FakeCdp extends EventEmitter {
  send = vi.fn(async (_method: string, _params?: unknown) => ({}));
  detach = vi.fn(async (): Promise<void> => {
    this.emit("close", this);
  });

  paint(sessionId = 1, data = jpeg): void {
    this.emit("Page.screencastFrame", {
      sessionId,
      data: data.toString("base64"),
      metadata: {
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 12,
        scrollOffsetY: 34,
        timestamp: 123,
      },
    });
  }

  acks() {
    return this.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck");
  }
}

class FakePage extends EventEmitter {
  private capture?: FakeCdp;
  newCDPSession = vi.fn(async () => (this.capture = new FakeCdp()));

  get cdp(): FakeCdp {
    return expectDefined(this.capture, "capture session");
  }

  currentUrl = "https://example.test/";
  currentTitle = "Example";
  title = vi.fn(async () => this.currentTitle);
  url = () => this.currentUrl;
  mainFrame = () => this;
  isClosed = () => false;
  context = () => ({ newCDPSession: this.newCDPSession });

  navigate(url: string): void {
    this.currentUrl = url;
    this.emit("framenavigated", this);
  }

  paint(sessionId = 1): void {
    this.capture?.paint(sessionId);
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("browser screencast sessions", () => {
  let page: FakePage;
  let check: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakePage();
    check = vi.fn(async () => {});
    mocks.getPage.mockReset().mockResolvedValue(page as unknown as Page);
  });

  afterEach(() => stopBrowserScreencasts().finally(() => vi.useRealTimers()));

  async function attach(
    params = screencastParams({ checkNavigationAllowed: check }),
    ingress?: Parameters<typeof attachBrowserScreencastViewer>[2],
  ): Promise<ScreencastViewer> {
    const viewer = new ScreencastViewer();
    attachBrowserScreencastViewer(params, viewer as unknown as WebSocket, ingress);
    await flush();
    return viewer;
  }

  it.each(["abort", "invalidate"])("revokes %s without interrupting peers", async (mode) => {
    const requester = requesterState();
    const survivor = requesterState();
    const first = await attach(requesterParams(requester));
    const second = await attach(requesterParams(survivor));
    page.paint(1);
    if (mode === "abort") {
      requester.abort();
      expect(first.close).toHaveBeenCalledWith(4006, "authority_revoked");
      expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    } else {
      requester.invalidated = true;
    }
    page.paint(2);
    page.paint(3);
    expect([first.frames().length, second.frames().length]).toEqual([1, 3]);
    expect(first.close.mock.calls).toEqual([[4006, "authority_revoked"]]);
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    expect(second.close).not.toHaveBeenCalled();
    expect(page.cdp.detach).not.toHaveBeenCalled();
    survivor.abort();
    expect(second.close).toHaveBeenCalledWith(4006, "authority_revoked");
    await flush();
    expect(page.cdp.detach).toHaveBeenCalledOnce();
  });

  it.each(["ready", "meta"])("fences %s after title-read revocation", async (message) => {
    const requester = requesterState();
    const params = requesterParams(requester);
    const viewer = message === "meta" ? await attach(params) : new ScreencastViewer();
    if (message === "meta") {
      viewer.send.mockClear();
    }
    page.title.mockImplementationOnce(async () => {
      requester.invalidated = true;
      return "Revoked title";
    });
    if (message === "ready") {
      attachBrowserScreencastViewer(params, viewer as unknown as WebSocket);
    } else {
      page.emit("load");
    }
    await flush();
    expect(requester.signal.aborted).toBe(false);
    expect(viewer.send).not.toHaveBeenCalled();
    expect(viewer.close.mock.calls).toEqual([[4006, "authority_revoked"]]);
  });

  it("rejects a requester revoked before viewer attachment without starting capture", async () => {
    const viewer = await attach(screencastParams({ requesterSignal: AbortSignal.abort() }));
    expect(viewer.close).toHaveBeenCalledWith(4006, "authority_revoked");
    expect(page.newCDPSession).not.toHaveBeenCalled();
  });

  it("shares one JPEG message across viewers, skips congestion, and ack-paces every frame", async () => {
    const first = await attach();
    const second = await attach();
    expect(page.cdp.send).toHaveBeenCalledWith("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 1280,
      everyNthFrame: 1,
    });
    page.paint(1);
    expect(first.frames()[0]).toBe(second.frames()[0]);
    expect(first.frames().map(parseScreencastFrame)).toEqual([expectedFrame()]);
    await vi.advanceTimersByTimeAsync(49);
    expect(page.cdp.acks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    second.bufferedAmount = 2 * 1024 * 1024;
    page.paint(2);
    await vi.advanceTimersByTimeAsync(50);
    first.bufferedAmount = 2 * 1024 * 1024;
    page.paint(3);
    await vi.advanceTimersByTimeAsync(50);
    expect([first.frames().length, second.frames().length]).toEqual([2, 1]);
    expect(page.cdp.acks()).toEqual(
      [1, 2, 3].map((sessionId) => ["Page.screencastFrameAck", { sessionId }]),
    );
  });

  it.each(["event blocked", "frame allowed", "stale blocked"])(
    "fences %s navigation",
    async (mode) => {
      const viewer = await attach();
      const retired = page.cdp;
      page.paint(9);
      viewer.send.mockClear();
      retired.send.mockClear();
      const policy = hold(check);
      page.currentUrl = mode === "stale blocked" ? "https://blocked.test/" : nextUrl;
      if (mode !== "frame allowed") {
        page.navigate(page.currentUrl);
        expect(retired.detach).toHaveBeenCalledOnce();
      }
      page.paint(10);
      expect(retired.detach).toHaveBeenCalledOnce();
      expect(page.newCDPSession).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(viewer.frames()).toHaveLength(0);
      expect(retired.send).not.toHaveBeenCalled();
      if (mode === "stale blocked") {
        const next = hold(check);
        page.navigate(nextUrl);
        policy.reject(new Error("blocked"));
        await flush();
        expect(page.newCDPSession).toHaveBeenCalledTimes(1);
        await resume(next, undefined);
      } else if (mode === "event blocked") {
        policy.reject(new Error("blocked"));
        await flush();
      } else {
        await resume(policy, undefined);
      }
      retired.paint(99, Buffer.from([0xff, 0xd8, 0x42, 0xff, 0xd9]));
      expect(viewer.frames()).toHaveLength(0);
      page.paint(100);
      await vi.advanceTimersByTimeAsync(50);
      expect(retired.detach).toHaveBeenCalledOnce();
      if (mode === "event blocked") {
        expect(viewer.frames()).toHaveLength(0);
        expect(viewer.close).toHaveBeenCalledWith(4003, "navigation_blocked");
      } else {
        expect(page.newCDPSession).toHaveBeenCalledTimes(2);
        expect(viewer.frames().map(parseScreencastFrame)).toEqual([expectedFrame(nextUrl)]);
        expect(page.cdp.acks()).toEqual([["Page.screencastFrameAck", { sessionId: 100 }]]);
        expect(viewer.close).not.toHaveBeenCalled();
      }
    },
  );

  it("checks the initial URL before ready or frames, and ignores stale navigation completions", async () => {
    const initial = hold(check);
    const viewer = await attach();
    expect(page.newCDPSession).not.toHaveBeenCalled();
    page.paint();
    expect(viewer.send).not.toHaveBeenCalled();
    page.currentTitle = "Next";
    page.navigate(nextUrl);
    await flush();
    await resume(initial, undefined);
    page.paint(2);
    expect(viewer.messages()).toEqual([
      { type: "ready", targetId: "target-1", url: nextUrl, title: "Next" },
    ]);
    expect(viewer.frames().map(parseScreencastFrame)).toEqual([expectedFrame(nextUrl)]);
    page.currentTitle = "Loaded";
    page.emit("load");
    await flush();
    expect(viewer.messages().at(-1)).toEqual({ type: "meta", url: nextUrl, title: "Loaded" });
  });

  it("closes viewers with target_closed when CDP closes", async () => {
    const viewer = await attach();
    page.cdp.emit("close", page.cdp);
    expect(viewer.close).toHaveBeenCalledWith(4004, "target_closed");
    await flush();
    expect(page.cdp.detach).toHaveBeenCalledTimes(1);
  });

  it("revalidates lifecycle after page acquisition and never attaches a stale token to a successor", async () => {
    const acquired = hold(mocks.getPage);
    const lifecycle = new AbortController();
    const params = screencastParams({ lifecycleSignal: lifecycle.signal });
    const pending = await attach(params);
    lifecycle.abort();
    await resume(acquired, page as unknown as Page);
    expect(pending.close).toHaveBeenCalledWith(4004, "target_closed");
    expect(page.newCDPSession).not.toHaveBeenCalled();
    const profileSignal = new AbortController().signal;
    const successor = await attach(screencastParams({ profileSignal }));
    const stale = await attach(params);
    expect(stale.close).toHaveBeenCalledWith(4004, "target_closed");
    expect(successor.close).not.toHaveBeenCalled();
  });

  it("waits for predecessor teardown before starting a replacement on the same target", async () => {
    const first = await attach();
    const detached = hold(page.cdp.detach);
    first.close();
    await flush();
    const successor = await attach();
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
    expect(successor.send).not.toHaveBeenCalled();
    await resume(detached, undefined);
    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(successor.messages()).toHaveLength(1);
  });

  it("retains ingress cleanup until CDP detach completes and fences pending page acquisition", async () => {
    const work: Promise<unknown>[] = [];
    const grant = new AbortController();
    let current = true;
    const ingress = {
      signal: grant.signal,
      isCurrent: () => current,
      trackWork<T>(pending: Promise<T>) {
        work.push(pending);
        return pending;
      },
    };
    const viewer = await attach(screencastParams(), ingress);
    const detached = hold(page.cdp.detach);
    grant.abort();
    expect(viewer.close).toHaveBeenCalledWith(4006, "authority_revoked");
    const settled = vi.fn();
    const drain = Promise.all(work).then(settled);
    await flush();
    try {
      expect(settled).not.toHaveBeenCalled();
    } finally {
      detached.resolve();
    }
    await drain;
    expect(settled).toHaveBeenCalledOnce();

    const acquired = hold(mocks.getPage);
    const nextIngress = { ...ingress, signal: new AbortController().signal };
    const next = await attach(screencastParams(), nextIngress);
    current = false;
    const captures = page.newCDPSession.mock.calls.length;
    await resume(acquired, page as unknown as Page);
    await Promise.all(work);
    expect(page.newCDPSession).toHaveBeenCalledTimes(captures);
    expect(next.close).toHaveBeenCalledWith(4006, "authority_revoked");
  });

  it("does not send stale metadata after a title read crosses a navigation", async () => {
    const viewer = await attach();
    const title = hold(page.title);
    page.emit("load");
    page.currentTitle = "Next";
    page.navigate(nextUrl);
    await flush();
    await resume(title, "Old title");
    expect(viewer.messages()).toEqual([
      { type: "ready", targetId: "target-1", url: "https://example.test/", title: "Example" },
      { type: "meta", url: nextUrl, title: "Next" },
    ]);
  });
});
