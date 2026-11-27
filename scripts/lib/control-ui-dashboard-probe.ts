import type { ApplicationContext } from "../../ui/src/app/context.ts";
import type { BoardSnapshot } from "../../ui/src/lib/board/types.ts";
import type { ControlUiMockGateway } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";

/** Renew the ticket without changing the document generation on warm reload. */
export function installRotatingBoardTickets(
  snapshot: BoardSnapshot,
  gateway: Pick<ControlUiMockGateway, "setRequestHandler">,
) {
  let generation = 0;
  gateway.setRequestHandler("board.get", ({ respond }) => {
    const board = structuredClone(snapshot);
    for (const widget of board.widgets) {
      if (widget.viewTicket && widget.frameUrl) {
        widget.viewTicket = `fixture-ticket-${performance.timeOrigin}-${++generation}`;
        const url = new URL(widget.frameUrl);
        url.searchParams.set("bt", widget.viewTicket);
        widget.frameUrl = url.href;
      }
    }
    respond(board);
  });
}

/** Serialized before app modules; all timestamps use the host document's clock. */
export function installWidgetReadiness() {
  const ready = new Map<string, number>();
  const boardFrames = new Map<HTMLIFrameElement, number>();
  const frameEvents: Array<{ id: number; stage: string; at: number }> = [];
  const recordFrame = (frame: HTMLIFrameElement, stage: string) =>
    frameEvents.push({
      id: [...boardFrames.keys()].indexOf(frame) + 1,
      stage,
      at: performance.now(),
    });
  let helloObserverAttachedMs: number | null = null;
  let helloPublishedMs: number | null = null;
  let helloHandledMs: number | null = null;
  let stopGateway: (() => void) | undefined;
  let active = true;
  const receiveContext = (event: Event) => {
    const provider = event as Event & { context?: unknown; contextTarget?: HTMLElement };
    if (
      helloObserverAttachedMs !== null ||
      provider.context !== "openclaw.application" ||
      provider.contextTarget?.localName !== "openclaw-app"
    ) {
      return;
    }
    // The provider announces before connect; request its existing context before shell render.
    const consumer = document.createElement("span");
    provider.contextTarget.append(consumer);
    try {
      consumer.dispatchEvent(
        Object.assign(new Event("context-request", { bubbles: true, composed: true }), {
          context: "openclaw.application",
          contextTarget: consumer,
          subscribe: false,
          callback: (context: ApplicationContext) => {
            helloObserverAttachedMs = performance.now();
            stopGateway = context.gateway.subscribe((snapshot) => {
              if (snapshot.phase !== "connected" || helloPublishedMs !== null) {
                return;
              }
              helloPublishedMs = performance.now();
              queueMicrotask(() => {
                if (active) {
                  helloHandledMs = performance.now();
                }
                stopGateway?.();
                stopGateway = undefined;
              });
            });
          },
        }),
      );
    } finally {
      consumer.remove();
    }
    if (helloObserverAttachedMs !== null) {
      window.removeEventListener("context-provider", receiveContext);
    }
  };
  window.addEventListener("context-provider", receiveContext);
  window.addEventListener(
    "pagehide",
    () => {
      active = false;
      stopGateway?.();
      window.removeEventListener("context-provider", receiveContext);
    },
    { once: true },
  );
  const stages = {
    iframeInsertedMs: null as number | null,
    sandboxDocLoadedMs: null as number | null,
    sandboxProxyReadyMs: null as number | null,
    resourceLoadedMs: null as number | null,
    firstResizeMs: null as number | null,
    appReadyMs: null as number | null,
    fontLoaded: false,
  };
  const observeFrame = (frame: HTMLIFrameElement) => {
    if (
      !frame.matches(".board-widget__frame, openclaw-board-view mcp-app-view iframe") ||
      boardFrames.has(frame)
    ) {
      return;
    }
    boardFrames.set(frame, performance.now());
    recordFrame(frame, "inserted");
    stages.iframeInsertedMs ??= performance.now();
    frame.addEventListener("load", () => {
      recordFrame(frame, "load");
      stages.sandboxDocLoadedMs ??= performance.now();
    });
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.target instanceof HTMLIFrameElement &&
        boardFrames.has(record.target) &&
        !record.target.style.opacity
      ) {
        recordFrame(record.target, "revealed");
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLIFrameElement) {
          observeFrame(node);
        } else if (node instanceof Element) {
          node
            .querySelectorAll<HTMLIFrameElement>(
              ".board-widget__frame, openclaw-board-view mcp-app-view iframe",
            )
            .forEach(observeFrame);
        }
      }
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  window.addEventListener("message", (event) => {
    const method = event.data?.method;
    const type = event.data?.type;
    if (
      method !== "ui/notifications/sandbox-resource-loaded" &&
      method !== "ui/notifications/initialized" &&
      method !== "ui/notifications/sandbox-proxy-ready" &&
      type !== "openclaw:widget-size" &&
      type !== "openclaw:bench-dashboard-ready"
    ) {
      return;
    }
    const boardFrame = [...boardFrames.keys()].find(
      (frame) => frame.contentWindow === event.source,
    );
    if (boardFrame) {
      const at = performance.now();
      if (method === "ui/notifications/sandbox-proxy-ready") {
        stages.sandboxProxyReadyMs ??= at;
      } else if (method === "ui/notifications/sandbox-resource-loaded") {
        stages.resourceLoadedMs ??= at;
      } else if (type === "openclaw:widget-size") {
        stages.firstResizeMs ??= at;
      } else if (type === "openclaw:bench-dashboard-ready") {
        stages.appReadyMs ??= at;
        stages.fontLoaded = event.data.fontLoaded === true;
      }
    }
    if (
      method !== "ui/notifications/sandbox-resource-loaded" &&
      method !== "ui/notifications/initialized"
    ) {
      return;
    }
    for (const [kind, selector] of [
      ["board", ".board-widget__frame, openclaw-board-view mcp-app-view iframe"],
      ["inline", ".chat-tool-card__preview-frame"],
    ] as const) {
      const frames = [...document.querySelectorAll<HTMLIFrameElement>(selector)];
      const index = frames.findIndex((frame) => frame.contentWindow === event.source);
      const key = `${kind}:${index}`;
      if (index >= 0 && !ready.has(key)) {
        ready.set(key, performance.now());
      }
    }
  });
  Reflect.set(window, "__readWidgetReadiness", () => {
    const rpcs: Array<{ method: string; ms: number }> =
      Reflect.get(window, "__coldLoad")?.read().rpcs ?? [];
    const response = (method: string, phase: "start" | "end") => {
      const index = rpcs.findIndex((rpc) => rpc.method === method);
      return index < 0
        ? null
        : (performance.getEntriesByName(`cold-load-rpc:${index}:${method}:${phase}`)[0]
            ?.startTime ?? null);
    };
    const connectResponseMs = response("connect", "start");
    const connect = rpcs.find((rpc) => rpc.method === "connect");
    const boardFetches = performance
      .getEntriesByType("resource")
      .filter((entry) => new URL(entry.name).pathname.startsWith("/__openclaw__/board/"))
      .map((entry) => ({ startMs: entry.startTime, endMs: entry.startTime + entry.duration }));
    return {
      measurement:
        "host timestamps; hello-handled is the microtask after connected publication; resource-loaded follows the srcdoc load, app-ready follows the synthetic app font and two animation frames; neither is a compositor paint timestamp",
      firstInlineReadyMs: [...ready].find(([key]) => key.startsWith("inline:"))?.[1] ?? null,
      firstBoardReadyMs: [...ready].find(([key]) => key.startsWith("board:"))?.[1] ?? null,
      ready: Object.fromEntries(ready),
      dashboardStages: {
        connectSentMs:
          connectResponseMs !== null && connect ? connectResponseMs - connect.ms : null,
        connectDispatchEndMs: response("connect", "end"),
        helloObserverAttachedMs,
        helloPublishedMs,
        helloHandledMs,
        boardGetResponseMs: response("board.get", "start"),
        discoverResponseMs: response("mcp.app.discover", "start"),
        ...stages,
        frameEvents,
        iframeInsertions: boardFrames.size,
        boardFetchCount: boardFetches.length,
        boardFetchStartMs: boardFetches[0]?.startMs ?? null,
        boardFetchEndMs: boardFetches[0]?.endMs ?? null,
        boardFetches,
      },
    };
  });
}
