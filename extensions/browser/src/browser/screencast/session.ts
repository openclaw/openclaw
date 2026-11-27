import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import type { CDPSession, Frame, Page } from "playwright-core";
import { getPwAiModule } from "../pw-ai-module.js";
import { clearBrowserScreencastTokens, type BrowserScreencastTokenParams } from "./tokens.js";

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
// Ack retry delay while every viewer socket is congested.
const CONGESTED_ACK_DELAY_MS = 50;
const sessions = new Map<string, BrowserScreencastSession>();

type ScreencastFrame = {
  sessionId: number;
  data: string;
  metadata: {
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
};
type ViewerRequester = {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  release?: () => void;
  trackWork?: <T>(work: Promise<T>) => Promise<T>;
};
type ViewerIngress = Pick<ViewerRequester, "signal" | "isCurrent" | "trackWork">;

class BrowserScreencastSession {
  readonly viewers = new Map<WebSocket, ViewerRequester>();
  private readonly readyViewers = new Set<WebSocket>();
  private readonly acknowledgements = new Set<ReturnType<typeof setTimeout>>();
  // Acknowledges the frame still waiting on a viewer's write, if any.
  private pendingAck: (() => void) | undefined;
  private page?: Page;
  private capture?: { cdp: CDPSession; onFrame: (frame: ScreencastFrame) => void };
  private captureDrain: Promise<void> = Promise.resolve();
  closed = false;
  private navigationEpoch = 0;
  private checkedUrl?: string;
  private metadata?: { url: string; title: string };
  private stopPromise?: Promise<void>;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    readonly key: string,
    readonly params: BrowserScreencastTokenParams,
  ) {
    params.lifecycleSignal.addEventListener("abort", this.onTargetClosed, { once: true });
  }

  addViewer(ws: WebSocket, requester: ViewerRequester): void {
    const onRequesterGone = () => ws.close(4006, "authority_revoked");
    this.viewers.set(ws, requester);
    for (const work of this.pending) {
      void requester.trackWork?.(work);
    }
    ws.once("close", () => {
      requester.signal?.removeEventListener("abort", onRequesterGone);
      requester.release?.();
      this.viewers.delete(ws);
      this.readyViewers.delete(ws);
      if (this.viewers.size === 0) {
        const cleanup = this.close();
        void requester.trackWork?.(cleanup);
      }
    });
    requester.signal?.addEventListener("abort", onRequesterGone, { once: true });
    if (!this.isViewerCurrent(ws)) {
      return;
    }
    this.sendReady();
  }

  trackWork(work: Promise<void>): Promise<void> {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    for (const requester of this.viewers.values()) {
      void requester.trackWork?.(work);
    }
    return work;
  }

  private isViewerCurrent(ws: WebSocket): boolean {
    const requester = this.viewers.get(ws);
    if (!requester) {
      return false;
    }
    if (requester.signal?.aborted || requester.isCurrent?.() === false) {
      ws.close(4006, "authority_revoked");
      return false;
    }
    return true;
  }

  private isCurrent(): boolean {
    if (this.closed) {
      return false;
    }
    try {
      this.params.lifecycleSignal.throwIfAborted();
      this.params.assertCurrent();
      if (![...this.viewers.keys()].some((ws) => this.isViewerCurrent(ws))) {
        this.onTargetClosed();
        return false;
      }
      return true;
    } catch {
      this.onTargetClosed();
      return false;
    }
  }

  async start(): Promise<void> {
    try {
      if (!this.isCurrent()) {
        return;
      }
      const pw = await getPwAiModule();
      if (!this.isCurrent()) {
        return;
      }
      if (!pw) {
        await this.close(4005, "unsupported");
        return;
      }
      const page = await pw.getPageForTargetId({
        cdpUrl: this.params.cdpUrl,
        targetId: this.params.targetId,
        ssrfPolicy: this.params.ssrfPolicy,
      });
      if (!this.isCurrent() || page.isClosed()) {
        this.onTargetClosed();
        return;
      }
      this.page = page;
      page.on("close", this.onTargetClosed);
      page.on("framenavigated", this.onNavigation);
      page.on("load", this.onLoad);
      await this.checkNavigation(page.url());
    } catch {
      await this.close(4004, "target_closed");
    }
  }

  private readonly onTargetClosed = (): void => {
    void this.close(4004, "target_closed");
  };

  private readonly onCdpClosed = (cdp: CDPSession): void => {
    if (this.capture?.cdp === cdp) {
      this.onTargetClosed();
    }
  };

  private readonly onNavigation = (frame: Frame): void => {
    if (frame === this.page?.mainFrame()) {
      void this.trackWork(this.checkNavigation(this.page.url()));
    }
  };

  private readonly onLoad = (): void => {
    void this.trackWork(this.updateMetadata(this.navigationEpoch));
  };

  private async checkNavigation(url: string): Promise<void> {
    const retired = this.retireCapture();
    const epoch = this.navigationEpoch;
    try {
      await this.params.checkNavigationAllowed(url);
    } catch {
      if (epoch === this.navigationEpoch) {
        void this.close(4003, "navigation_blocked");
      }
      return;
    }
    const page = this.page;
    const current = () => this.isCurrent() && epoch === this.navigationEpoch && page?.url() === url;
    if (!page || !current()) {
      return;
    }
    try {
      await retired;
      if (!current()) {
        return;
      }
      const cdp = await page.context().newCDPSession(page);
      if (!current()) {
        await cdp.detach().catch(() => {});
        return;
      }
      const onFrame = (frame: ScreencastFrame) => this.onFrame(cdp, frame);
      this.capture = { cdp, onFrame };
      cdp.on("close", this.onCdpClosed);
      cdp.on("Page.screencastFrame", onFrame);
      this.checkedUrl = url;
      await this.updateMetadata(epoch);
      if (!current() || this.capture?.cdp !== cdp) {
        return;
      }
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.params.quality,
        maxWidth: this.params.maxWidth,
        maxHeight: this.params.maxHeight,
        everyNthFrame: 1,
      });
    } catch {
      if (current()) {
        this.onTargetClosed();
      }
    }
  }

  private async updateMetadata(epoch: number): Promise<void> {
    const page = this.page;
    const url = this.checkedUrl;
    if (!page || url === undefined || page.url() !== url) {
      return;
    }
    const title = await page.title().catch(() => "");
    if (!this.isCurrent() || epoch !== this.navigationEpoch || this.checkedUrl !== page.url()) {
      return;
    }
    this.metadata = { url, title };
    for (const ws of this.readyViewers) {
      this.send(ws, JSON.stringify({ type: "meta", ...this.metadata }));
    }
    this.sendReady();
  }

  private sendReady(): void {
    if (
      !this.isCurrent() ||
      !this.metadata ||
      this.metadata.url !== this.checkedUrl ||
      this.page?.url() !== this.checkedUrl
    ) {
      return;
    }
    let joined = false;
    for (const ws of this.viewers.keys()) {
      if (
        !this.readyViewers.has(ws) &&
        this.send(
          ws,
          JSON.stringify({ type: "ready", targetId: this.params.targetId, ...this.metadata }),
        )
      ) {
        this.readyViewers.add(ws);
        joined = true;
      }
    }
    if (joined) {
      // A viewer that joins while the only writer stalls must not inherit its frozen
      // capture: release Chrome's held frame so the next one reaches everyone.
      this.pendingAck?.();
    }
  }

  private send(ws: WebSocket, data: string | Buffer, onWritten?: () => void): boolean {
    if (!this.isViewerCurrent(ws) || ws.readyState !== 1) {
      return false;
    }
    if (typeof data !== "string" && ws.bufferedAmount >= MAX_BUFFERED_BYTES) {
      return false;
    }
    try {
      ws.send(data, (error) => {
        if (error) {
          ws.terminate();
        }
        onWritten?.();
      });
      return true;
    } catch {
      ws.terminate();
      return false;
    }
  }

  private onFrame(cdp: CDPSession, frame: ScreencastFrame): void {
    const page = this.page;
    if (this.capture?.cdp !== cdp || !page || !this.isCurrent()) {
      return;
    }
    const url = this.checkedUrl;
    const pageUrl = page.url();
    if (pageUrl !== url) {
      void this.trackWork(this.checkNavigation(pageUrl));
      return;
    }
    if (url === undefined) {
      return;
    }
    const header = Buffer.from(
      JSON.stringify({
        url,
        cssWidth: frame.metadata.deviceWidth,
        cssHeight: frame.metadata.deviceHeight,
        scrollX: frame.metadata.scrollOffsetX,
        scrollY: frame.metadata.scrollOffsetY,
        ts: frame.metadata.timestamp,
      }),
      "utf8",
    );
    const jpeg = Buffer.from(frame.data, "base64");
    const wire = Buffer.allocUnsafe(4 + header.length + jpeg.length);
    wire.writeUInt32BE(header.length, 0);
    header.copy(wire, 4);
    jpeg.copy(wire, 4 + header.length);
    // Chrome retains one unacked frame. Acking once the first viewer has taken this
    // frame paces capture to the fastest delivery without a frame queue; slower
    // viewers fall behind to MAX_BUFFERED_BYTES and then skip frames.
    let acked = false;
    const ack = () => {
      if (this.pendingAck === ack) {
        this.pendingAck = undefined;
      }
      if (acked || this.capture?.cdp !== cdp || !this.isCurrent()) {
        return;
      }
      acked = true;
      void this.trackWork(
        cdp
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .then(() => undefined)
          .catch(() => {
            if (this.capture?.cdp === cdp) {
              this.onTargetClosed();
            }
          }),
      );
    };
    let accepted = false;
    for (const ws of this.readyViewers) {
      accepted = this.send(ws, wire, ack) || accepted;
    }
    if (accepted) {
      if (!acked) {
        this.pendingAck = ack;
      }
      return;
    }
    // No viewer took the frame: back off before asking Chrome for another.
    const timer = setTimeout(() => {
      this.acknowledgements.delete(timer);
      ack();
    }, CONGESTED_ACK_DELAY_MS);
    timer.unref();
    this.acknowledgements.add(timer);
  }

  close(code?: number, reason?: string): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.closed = true;
    this.params.lifecycleSignal.removeEventListener("abort", this.onTargetClosed);
    this.page?.off("close", this.onTargetClosed);
    this.page?.off("framenavigated", this.onNavigation);
    this.page?.off("load", this.onLoad);
    const viewers = [...this.viewers.keys()];
    const requesters = [...this.viewers.values()];
    this.viewers.clear();
    this.readyViewers.clear();
    // Publish the drain before closing sockets; their close callbacks may reenter.
    this.stopPromise = this.retireCapture().finally(() => {
      if (sessions.get(this.key) === this) {
        sessions.delete(this.key);
      }
    });
    for (const requester of requesters) {
      void requester.trackWork?.(this.stopPromise);
    }
    for (const ws of viewers) {
      ws.close(code, reason);
    }
    return this.stopPromise;
  }

  private retireCapture(): Promise<void> {
    // Encoded frames belong to a CDP session, so revoke it before navigation checks yield.
    this.checkedUrl = undefined;
    this.navigationEpoch += 1;
    const capture = this.capture;
    this.capture = undefined;
    this.pendingAck = undefined;
    for (const timer of this.acknowledgements) {
      clearTimeout(timer);
    }
    this.acknowledgements.clear();
    if (capture) {
      const { cdp, onFrame } = capture;
      cdp.off("close", this.onCdpClosed);
      cdp.off("Page.screencastFrame", onFrame);
      this.captureDrain = Promise.all([this.captureDrain, cdp.detach().catch(() => {})]).then(
        () => {},
      );
    }
    return this.captureDrain;
  }
}

export function attachBrowserScreencastViewer(
  params: BrowserScreencastTokenParams,
  ws: WebSocket,
  ingress?: ViewerIngress,
): void {
  if (
    params.requesterSignal?.aborted ||
    params.isRequesterCurrent?.() === false ||
    ingress?.signal?.aborted ||
    ingress?.isCurrent?.() === false
  ) {
    params.releaseRequester?.();
    ws.close(4006, "authority_revoked");
    return;
  }
  try {
    params.lifecycleSignal.throwIfAborted();
    params.assertCurrent();
  } catch {
    params.releaseRequester?.();
    ws.close(4004, "target_closed");
    return;
  }
  const key = `${params.profileName}:${params.targetId}`;
  const requester = {
    signal: ingress?.signal
      ? params.requesterSignal
        ? AbortSignal.any([params.requesterSignal, ingress.signal])
        : ingress.signal
      : params.requesterSignal,
    isCurrent: () => params.isRequesterCurrent?.() !== false && ingress?.isCurrent?.() !== false,
    release: params.releaseRequester,
    trackWork: ingress?.trackWork,
  };
  let session = sessions.get(key);
  let previousDrain: Promise<void> | undefined;
  if (session && (session.closed || session.params.profileSignal !== params.profileSignal)) {
    previousDrain = session.close(4004, "target_closed");
    session = undefined;
  }
  if (session) {
    session.addViewer(ws, requester);
    return;
  }
  session = new BrowserScreencastSession(key, params);
  sessions.set(key, session);
  session.addViewer(ws, requester);
  const next = session;
  // Finish retiring the predecessor before attaching a replacement to the same page.
  void next.trackWork(Promise.resolve(previousDrain).then(() => next.start()));
}

export function stopBrowserScreencasts(): Promise<void> {
  clearBrowserScreencastTokens();
  const drains = [...sessions.values()].map((session) =>
    session.close(1012, "gateway shutting down"),
  );
  return Promise.allSettled(drains).then(() => {});
}
