import type { ApplicationContext } from "../../ui/src/app/context.ts";

export const proofRegions = {
  sidebar: "aside.sidebar",
  header: ".chat-pane__header",
  transcript: ".chat-thread-viewport, .chat-thread",
  details: ".chat-details",
  composer: ".agent-chat__input",
  dashboard: "openclaw-board-view",
};

/** Serialized into the top document before its application modules execute. */
export function installWarmReloadBrowserProbe(route: string) {
  if (window !== window.top) {
    return undefined;
  }
  const data = {
    firstAppDomMs: null as number | null,
    firstMainDomMs: null as number | null,
    firstDashboardContentDomMs: null as number | null,
    firstPaintedRowsMs: null as number | null,
    finalRowsDomMs: null as number | null,
    helloPublishedMs: null as number | null,
    helloHandledMs: null as number | null,
    fcpMs: null as number | null,
    cls: 0,
    loafBlockingMs: 0,
    loaf: [] as Array<{ atMs: number; durationMs: number; blockingMs: number }>,
    shifts: [] as Array<{ atMs: number; value: number }>,
    domStates: [] as Array<{ atMs: number; rows: number; sidebarRows: number; board: boolean }>,
    masks: [] as Array<{
      name: string;
      reason: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>,
    maskPolicy: {
      caret:
        "A collapsed editable selection is masked at its measured caret rectangle; empty inputs use their padded text origin.",
      animation: "Only small spinner/icon rectangles; skeletons and content remain visible.",
    },
    stopped: false,
  };
  Reflect.set(window, "__warmReloadProof", data);
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      typeof event.data === "object" &&
      event.data !== null &&
      "type" in event.data &&
      event.data.type === "warm-reload-proof:dashboard-content-ready"
    ) {
      data.firstDashboardContentDomMs ??= performance.now();
      if (
        route === "dashboard" &&
        document
          .querySelector("openclaw-board-view")
          ?.closest("[data-region]")
          ?.getAttribute("data-region") === "main"
      ) {
        data.firstMainDomMs ??= data.firstDashboardContentDomMs;
      }
    }
  });
  const observe = (type: string, handle: (entry: PerformanceEntry) => void) => {
    if (PerformanceObserver.supportedEntryTypes.includes(type)) {
      new PerformanceObserver((entries) => entries.getEntries().forEach(handle)).observe({
        type,
        buffered: true,
      });
    }
  };
  observe("paint", (entry) => {
    if (entry.name === "first-contentful-paint") {
      data.fcpMs = entry.startTime;
    }
  });
  observe("element", (entry) => {
    const identifier: unknown = Reflect.get(entry, "identifier");
    const renderTime: unknown = Reflect.get(entry, "renderTime");
    if (identifier === "openclaw-transcript" && typeof renderTime === "number" && renderTime > 0) {
      data.firstPaintedRowsMs ??= renderTime;
    }
  });
  let firstShift = 0;
  let lastShift = 0;
  let shiftValue = 0;
  observe("layout-shift", (entry) => {
    if (Reflect.get(entry, "hadRecentInput")) {
      return;
    }
    const value = Number(Reflect.get(entry, "value"));
    data.shifts.push({ atMs: entry.startTime, value });
    if (
      lastShift === 0 ||
      entry.startTime - firstShift >= 5000 ||
      entry.startTime - lastShift >= 1000
    ) {
      firstShift = entry.startTime;
      shiftValue = 0;
    }
    lastShift = entry.startTime;
    shiftValue += value;
    data.cls = Math.max(data.cls, shiftValue);
  });
  observe("long-animation-frame", (entry) => {
    const blockingMs = Number(Reflect.get(entry, "blockingDuration"));
    data.loaf.push({ atMs: entry.startTime, durationMs: entry.duration, blockingMs });
    data.loafBlockingMs += blockingMs;
  });
  let stopGateway: (() => void) | undefined;
  const receiveContext = (event: Event) => {
    const provider = event as Event & { context?: unknown; contextTarget?: HTMLElement };
    if (provider.context !== "openclaw.application" || !provider.contextTarget) {
      return;
    }
    const consumer = document.createElement("span");
    provider.contextTarget.append(consumer);
    try {
      consumer.dispatchEvent(
        Object.assign(new Event("context-request", { bubbles: true, composed: true }), {
          context: "openclaw.application",
          contextTarget: consumer,
          subscribe: false,
          callback: (context: ApplicationContext) => {
            stopGateway = context.gateway.subscribe((snapshot) => {
              if (snapshot.phase === "connected" && data.helloPublishedMs === null) {
                data.helloPublishedMs = performance.now();
                queueMicrotask(() => {
                  data.helloHandledMs = performance.now();
                });
              }
            });
          },
        }),
      );
    } finally {
      consumer.remove();
    }
    window.removeEventListener("context-provider", receiveContext);
  };
  window.addEventListener("context-provider", receiveContext);
  window.addEventListener("pagehide", () => stopGateway?.(), { once: true });
  const textObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const element = node instanceof Element ? node : node.parentElement;
        if (
          !element ||
          (!element.closest(".chat-virtual-row") && !element.querySelector(".chat-virtual-row"))
        ) {
          continue;
        }
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        while ((text = walker.nextNode())) {
          const parent = text.parentElement;
          if (
            text.textContent?.trim() &&
            parent?.closest(".chat-virtual-row") &&
            !parent.hasAttribute("elementtiming")
          ) {
            parent.setAttribute("elementtiming", "openclaw-transcript");
          }
        }
      }
    }
  });
  textObserver.observe(document, { childList: true, subtree: true });
  const maskKeys = new Set<string>();
  const addMask = (
    name: string,
    reason: string,
    box: { x: number; y: number; width: number; height: number },
  ) => {
    const mask = {
      name,
      reason,
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      width: Math.ceil(box.width),
      height: Math.ceil(box.height),
    };
    const key = JSON.stringify(mask);
    if (!maskKeys.has(key)) {
      data.masks.push(mask);
      maskKeys.add(key);
    }
  };
  let previous = "";
  let previousRows = "";
  const sample = () => {
    if (data.stopped) {
      stopGateway?.();
      textObserver.disconnect();
      return;
    }
    const rowElements = [...document.querySelectorAll(".chat-virtual-row")];
    const rows = rowElements.length;
    const sidebarRows = document.querySelectorAll("openclaw-app-sidebar [data-session-key]").length;
    const board = Boolean(document.querySelector("openclaw-board-view iframe"));
    if (document.querySelector("openclaw-app-shell")) {
      data.firstAppDomMs ??= performance.now();
    }
    if (
      rowElements.some((row) => {
        const box = row.getBoundingClientRect();
        return (
          box.bottom > 0 &&
          box.y < innerHeight &&
          box.width > 0 &&
          row.closest("[data-region]")?.getAttribute("data-region") === "main" &&
          Boolean(row.querySelector(".chat-text")?.textContent?.trim())
        );
      })
    ) {
      data.firstMainDomMs ??= performance.now();
    }
    const rowSignature = rowElements
      .map(
        (row) =>
          `${row.getAttribute("data-virtual-row-key")}:${row.getBoundingClientRect().height}:${row.textContent?.length}`,
      )
      .join("|");
    if (rows > 0 && rowSignature !== previousRows) {
      data.finalRowsDomMs = performance.now();
    }
    previousRows = rowSignature;
    const state = `${rows}/${sidebarRows}/${board}`;
    if (state !== previous) {
      data.domStates.push({ atMs: performance.now(), rows, sidebarRows, board });
      previous = state;
    }
    for (const [selector, name, reason, maxWidth] of [
      [
        ".session-run-spinner, .btn__spinner, .desktop-spinner, .activity-pill__spinner, .chat-details-subagents__spinner, .icon--spin, .spinner",
        "spinner",
        "Small animated loading indicator",
        40,
      ],
      [
        ".chat-pane__connection-state, .sidebar-identity-card__status",
        "reconnect",
        "Permitted reconnect indicator",
        240,
      ],
      [
        ".chat-working-indicator__elapsed, .chat-subagents__elapsed, .subagents-desktop__elapsed",
        "clock",
        "Live elapsed clock",
        100,
      ],
    ] as const) {
      for (const element of document.querySelectorAll(selector)) {
        const box = element.getBoundingClientRect();
        if (box.width <= 0 || box.width > maxWidth || box.height <= 0 || box.height > 40) {
          continue;
        }
        addMask(name, reason, box);
      }
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      (active.isContentEditable ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement)
    ) {
      const selection = window.getSelection();
      const range =
        selection?.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : undefined;
      const rect = range?.getBoundingClientRect();
      if (rect && rect.height > 0 && rect.height <= 40 && rect.width <= 2) {
        addMask("caret", "Collapsed editable selection", {
          x: rect.x,
          y: rect.y,
          width: 2,
          height: rect.height,
        });
      } else if (
        !active.textContent &&
        (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ||
          !active.value)
      ) {
        const style = getComputedStyle(active);
        const box = active.getBoundingClientRect();
        addMask("caret", "Empty editable text origin", {
          x: box.x + Number.parseFloat(style.paddingLeft),
          y: box.y + Number.parseFloat(style.paddingTop),
          width: 2,
          height: Math.min(
            40,
            Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize),
          ),
        });
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  return data;
}
