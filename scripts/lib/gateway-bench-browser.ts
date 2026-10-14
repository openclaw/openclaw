import { performance } from "node:perf_hooks";
import type { Browser, Page } from "playwright";

export type BrowserSessionTarget = { key: string; marker: string };
export type BrowserSessionClick = {
  sessionKey: string;
  revisit: boolean;
  activeLoadAtStart: boolean;
  activeLoadAtFinish: boolean;
  historyVisibleMs: number | null;
  composerReadyMs: number | null;
  readyMs: number | null;
  longTasks: number[];
  error: string | null;
  paneStates: Array<{
    elapsedMs: number;
    loading: boolean | null;
    ready: boolean | null;
    connected: boolean | null;
    connectionEpoch: number | null;
    historyError: string | null;
  }>;
  connections: Array<{
    socketId: number;
    event: "created" | "open" | "hello" | "sequence-gap" | "closed" | "error";
    windowStartMs: number;
    reason?: string;
    tickIntervalMs?: number;
    inboundSilenceMs?: number;
    expectedSeq?: number;
    receivedSeq?: number;
  }>;
  requests: Array<{
    socketId: number;
    inherited: boolean;
    method: string;
    sessionKey: string | null;
    windowStartMs: number;
    latencyMs: number | null;
    responseBytes: number | null;
    ok: boolean | null;
    error: string | null;
  }>;
};

type ClickTiming = Pick<
  BrowserSessionClick,
  "historyVisibleMs" | "composerReadyMs" | "readyMs" | "longTasks" | "error" | "paneStates"
>;
type BenchmarkWindow = Window & {
  gatewayBenchmarkClick?: { result: Promise<ClickTiming>; cancel: (error: string) => void };
};

export async function startGatewayBrowserProbe(params: {
  port: number;
  timeoutMs: number;
  initial: BrowserSessionTarget;
  visibleSessions: number;
}) {
  const { chromium } = await import("playwright");
  const browser: Browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.trim() }
      : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(params.timeoutMs);
    type Request = Omit<BrowserSessionClick["requests"][number], "windowStartMs" | "inherited"> & {
      startedAt: number;
    };
    type Connection = Omit<BrowserSessionClick["connections"][number], "windowStartMs"> & {
      observedAt: number;
    };
    let requests: Request[] | undefined;
    const pending = new Map<string, Request>();
    const connections: Connection[] = [];
    const sockets = new Map<
      string,
      { id: number; lastInboundAt: number; lastSeq: number | null }
    >();
    let nextSocketId = 0;
    const recordConnection = (event: Omit<Connection, "observedAt">) => {
      if (connections.length === 256) {
        connections.shift();
      }
      connections.push({ ...event, observedAt: performance.now() });
    };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", ({ requestId }) => {
      if (sockets.size >= 256) {
        return;
      }
      const socket = { id: ++nextSocketId, lastInboundAt: performance.now(), lastSeq: null };
      sockets.set(requestId, socket);
      recordConnection({ socketId: socket.id, event: "created" });
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId }) => {
      const socket = sockets.get(requestId);
      if (socket) {
        recordConnection({ socketId: socket.id, event: "open" });
      }
    });
    const recordFrame = (
      requestId: string,
      payload: { opcode: number; payloadData: string },
      inbound: boolean,
    ) => {
      const socket = sockets.get(requestId);
      if (!socket) {
        return;
      }
      if (inbound) {
        socket.lastInboundAt = performance.now();
      }
      if (payload.opcode !== 1) {
        return;
      }
      let frame;
      try {
        frame = JSON.parse(payload.payloadData);
      } catch {
        return;
      }
      if (
        inbound &&
        frame.type === "event" &&
        frame.event !== "connect.challenge" &&
        typeof frame.seq === "number"
      ) {
        // Match the protocol client's socket-local outer event sequence contract.
        if (socket.lastSeq !== null && frame.seq > socket.lastSeq + 1) {
          recordConnection({
            socketId: socket.id,
            event: "sequence-gap",
            expectedSeq: socket.lastSeq + 1,
            receivedSeq: frame.seq,
          });
        }
        socket.lastSeq = frame.seq;
      }
      if (inbound && frame.type === "res" && frame.payload?.type === "hello-ok") {
        recordConnection({
          socketId: socket.id,
          event: "hello",
          tickIntervalMs: frame.payload.policy?.tickIntervalMs,
        });
      }
      const key = `${requestId}:${String(frame.id)}`;
      if (inbound) {
        const request = frame.type === "res" ? pending.get(key) : undefined;
        if (request) {
          request.latencyMs = performance.now() - request.startedAt;
          request.responseBytes = Buffer.byteLength(payload.payloadData);
          request.ok = frame.ok === true;
          request.error =
            frame.ok === false
              ? String(frame.error?.message ?? frame.error?.code ?? "RPC failed").slice(0, 512)
              : null;
          pending.delete(key);
        }
      } else if (
        frame.type === "req" &&
        [
          "sessions.resolve",
          "chat.startup",
          "chat.history",
          "sessions.list",
          "sessions.messages.subscribe",
          "sessions.messages.unsubscribe",
        ].includes(frame.method) &&
        pending.size < 256
      ) {
        const request: Request = {
          socketId: socket.id,
          method: String(frame.method),
          sessionKey:
            frame.params?.sessionKey ?? frame.params?.key ?? frame.params?.reference?.key ?? null,
          startedAt: performance.now(),
          latencyMs: null,
          responseBytes: null,
          ok: null,
          error: null,
        };
        if (requests && requests.length < 256) {
          requests.push(request);
        }
        pending.set(key, request);
      }
    };
    cdp.on("Network.webSocketFrameSent", ({ requestId, response }) =>
      recordFrame(requestId, response, false),
    );
    cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) =>
      recordFrame(requestId, response, true),
    );
    cdp.on("Network.webSocketFrameError", ({ requestId, errorMessage }) => {
      const socket = sockets.get(requestId);
      if (socket) {
        recordConnection({
          socketId: socket.id,
          event: "error",
          reason: errorMessage.slice(0, 512),
        });
      }
    });
    cdp.on("Network.webSocketClosed", ({ requestId }) => {
      const socket = sockets.get(requestId);
      if (socket) {
        recordConnection({
          socketId: socket.id,
          event: "closed",
          inboundSilenceMs: performance.now() - socket.lastInboundAt,
        });
        for (const [key, request] of pending) {
          if (request.socketId === socket.id) {
            request.error = "WebSocket closed before the response";
            pending.delete(key);
          }
        }
        sockets.delete(requestId);
      }
    });
    const startedAt = performance.now();
    await page.goto(`http://127.0.0.1:${params.port}/new`);
    await page.locator(".new-session-page__composer textarea").waitFor();
    // Expand the normal recent-session section before load can move idle targets below its cap.
    for (let shown = 10; shown < params.visibleSessions; shown += 10) {
      const more = page.locator('openclaw-app-sidebar button[aria-label="Show more"]').first();
      if (!(await more.count())) {
        break;
      }
      await more.click();
    }
    await page
      .locator(`openclaw-app-sidebar [data-session-key="${params.initial.key}"]`)
      .first()
      .waitFor();
    const newPageReadyMs = performance.now() - startedAt;
    const initialTiming = await measureSessionClick(page, params.initial, params.timeoutMs);
    if (initialTiming.error) {
      throw new Error(`Initial browser session did not load: ${initialTiming.error}`);
    }
    return {
      newPageReadyMs,
      initialSessionReadyMs: initialTiming.readyMs,
      close: () => browser.close(),
      click: async (
        target: BrowserSessionTarget,
        revisit: boolean,
        isActive: () => boolean,
        timeoutMs: number,
      ): Promise<BrowserSessionClick> => {
        const sampleStartedAt = performance.now();
        requests = [...pending.values()];
        const activeLoadAtStart = isActive();
        const timing = await measureSessionClick(page, target, timeoutMs);
        const observedRequests = requests;
        requests = undefined;
        return {
          sessionKey: target.key,
          revisit,
          activeLoadAtStart,
          activeLoadAtFinish: isActive(),
          ...timing,
          // Freeze each window; later replies belong to the next click's inherited records.
          requests: observedRequests.map((request) => ({
            socketId: request.socketId,
            method: request.method,
            sessionKey: request.sessionKey,
            latencyMs: request.latencyMs,
            responseBytes: request.responseBytes,
            ok: request.ok,
            error: request.error,
            inherited: request.startedAt < sampleStartedAt,
            windowStartMs: request.startedAt - sampleStartedAt,
          })),
          connections: connections.map((connection) => ({
            socketId: connection.socketId,
            event: connection.event,
            reason: connection.reason,
            tickIntervalMs: connection.tickIntervalMs,
            inboundSilenceMs: connection.inboundSilenceMs,
            expectedSeq: connection.expectedSeq,
            receivedSeq: connection.receivedSeq,
            windowStartMs: connection.observedAt - sampleStartedAt,
          })),
        };
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function measureSessionClick(
  page: Page,
  target: BrowserSessionTarget,
  timeoutMs: number,
): Promise<ClickTiming> {
  const row = page
    .locator(
      `openclaw-app-sidebar [data-session-key="${target.key}"] .sidebar-recent-session__link`,
    )
    .first();
  let armed = false;
  try {
    await row.waitFor({ state: "visible", timeout: timeoutMs });
    // The browser click event owns the clock, excluding Playwright actionability and transport.
    await page.evaluate(
      ({ target: expected, timeoutMs: budgetMs }) => {
        let resolve!: (timing: ClickTiming) => void;
        const promise = new Promise<ClickTiming>((complete) => {
          resolve = complete;
        });
        let startedAt: number | undefined;
        let historyVisibleMs: number | null = null;
        let composerReadyMs: number | null = null;
        const longTasks: number[] = [];
        const paneStates: ClickTiming["paneStates"] = [];
        const recordLongTasks = (entries: PerformanceEntry[]) => {
          const through = performance.now();
          for (const entry of entries) {
            if (startedAt !== undefined && longTasks.length < 512) {
              const overlap =
                Math.min(entry.startTime + entry.duration, through) -
                Math.max(entry.startTime, startedAt);
              if (overlap > 0) {
                longTasks.push(overlap);
              }
            }
          }
        };
        const performanceObserver = new PerformanceObserver((list) =>
          recordLongTasks(list.getEntries()),
        );
        performanceObserver.observe({ type: "longtask" });
        let frame = 0;
        let finished = false;
        const finish = (error: string | null) => {
          if (finished) {
            return;
          }
          finished = true;
          clearTimeout(timer);
          cancelAnimationFrame(frame);
          document.removeEventListener("click", onClick, true);
          recordLongTasks(performanceObserver.takeRecords());
          performanceObserver.disconnect();
          resolve({
            historyVisibleMs,
            composerReadyMs,
            longTasks,
            paneStates,
            readyMs: !error && startedAt !== undefined ? performance.now() - startedAt : null,
            error,
          });
        };
        const inspect = (afterReadyFrame = false) => {
          const pane = document.querySelector<
            HTMLElement & {
              sessionKey?: string;
              transcriptLoading?: boolean;
              transcriptReady?: boolean;
              state?: { connected: boolean; connectionEpoch: number };
            }
          >("openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])");
          if (startedAt !== undefined && pane?.sessionKey === expected.key) {
            const historyError =
              pane
                .querySelector(".chat-main__conversation > .chat-history-error:first-child > span")
                ?.textContent?.trim()
                .slice(0, 512) || null;
            const status = {
              loading: pane.transcriptLoading ?? null,
              ready: pane.transcriptReady ?? null,
              connected: pane.state?.connected ?? null,
              connectionEpoch: pane.state?.connectionEpoch ?? null,
              historyError,
            };
            const previous = paneStates.at(-1);
            if (
              paneStates.length < 128 &&
              (!previous ||
                previous.loading !== status.loading ||
                previous.ready !== status.ready ||
                previous.connected !== status.connected ||
                previous.connectionEpoch !== status.connectionEpoch ||
                previous.historyError !== status.historyError)
            ) {
              paneStates.push({ elapsedMs: performance.now() - startedAt, ...status });
            }
            const history = pane.querySelector(".chat-thread");
            if (
              history?.textContent?.includes(expected.marker) &&
              history.getBoundingClientRect().height > 0
            ) {
              historyVisibleMs ??= performance.now() - startedAt;
            }
            const composer = pane.querySelector<HTMLTextAreaElement>(
              ".agent-chat__composer-combobox textarea",
            );
            if (composer && !composer.disabled && composer.getBoundingClientRect().height > 0) {
              composerReadyMs ??= performance.now() - startedAt;
            }
            // The pane's ready getter includes failed loads. Its rendered error
            // precedes the transcript; pending-input errors below it are separate.
            if (historyError && pane.transcriptReady === true && pane.transcriptLoading === false) {
              finish(`History load failed: ${historyError}`);
              return;
            }
            if (
              historyVisibleMs !== null &&
              composerReadyMs !== null &&
              pane.transcriptLoading === false &&
              pane.transcriptReady === true
            ) {
              if (afterReadyFrame) {
                finish(null);
              } else {
                frame = requestAnimationFrame(() => inspect(true));
              }
              return;
            }
          }
          frame = requestAnimationFrame(() => inspect());
        };
        const onClick = (event: MouseEvent) => {
          if (
            !(event.target instanceof Element) ||
            !event.target.closest(`[data-session-key="${expected.key}"]`)
          ) {
            return;
          }
          document.removeEventListener("click", onClick, true);
          startedAt = performance.now();
          frame = requestAnimationFrame(() => inspect());
        };
        const timer = setTimeout(
          () => finish(`Session click did not become ready within ${budgetMs}ms`),
          budgetMs,
        );
        document.addEventListener("click", onClick, true);
        (window as BenchmarkWindow).gatewayBenchmarkClick = { result: promise, cancel: finish };
      },
      { target, timeoutMs },
    );
    armed = true;
    await row.click({ timeout: timeoutMs });
    return await page.evaluate(async () => {
      const pending = (window as BenchmarkWindow).gatewayBenchmarkClick;
      if (!pending) {
        throw new Error("Browser click measurement was not armed");
      }
      return await pending.result;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const partial = armed
      ? await page
          .evaluate(async (reason) => {
            const pending = (window as BenchmarkWindow).gatewayBenchmarkClick;
            pending?.cancel(reason);
            return await pending?.result;
          }, message)
          .catch(() => undefined)
      : undefined;
    return {
      historyVisibleMs: partial?.historyVisibleMs ?? null,
      composerReadyMs: partial?.composerReadyMs ?? null,
      longTasks: partial?.longTasks ?? [],
      paneStates: partial?.paneStates ?? [],
      readyMs: null,
      error: message,
    };
  }
}
