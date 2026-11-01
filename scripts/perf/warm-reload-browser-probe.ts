import type { ApplicationContext } from "../../ui/src/app/context.ts";
import type { ReloadAnimationSample } from "./warm-reload-frames.ts";

export const proofRegions = {
  sidebar: "aside.sidebar",
  header: ".chat-pane__header",
  transcript: ".chat-thread-viewport, .chat-thread",
  details: ".chat-details",
  composer: ".agent-chat__input, .agent-chat__disabled-banner--replacement",
  dashboard: "openclaw-board-view",
};

/** Serialized into the top document before its application modules execute. */
export function installWarmReloadBrowserProbe(route: string, traceIndexedDb = false) {
  if (window !== window.top) {
    return undefined;
  }
  const data = {
    firstAppDomMs: null as number | null,
    firstMainDomMs: null as number | null,
    firstTranscriptDomMs: null as number | null,
    firstDashboardContentDomMs: null as number | null,
    firstPaintedRowsMs: null as number | null,
    finalRowsDomMs: null as number | null,
    helloPublishedMs: null as number | null,
    helloHandledMs: null as number | null,
    fcpMs: null as number | null,
    cls: 0,
    loafBlockingMs: 0,
    loaf: [] as Array<{ atMs: number; durationMs: number; blockingMs: number }>,
    indexedDb: [] as Array<{
      store: string;
      operation: string;
      atMs: number;
      completedAtMs: number | null;
      outcome?: "success" | "error";
      found?: boolean;
    }>,
    shifts: [] as Array<{ atMs: number; value: number }>,
    domStates: [] as Array<{ atMs: number; rows: number; sidebarRows: number; board: boolean }>,
    sidebarFrames: [] as Array<{
      atMs: number;
      host: boolean;
      frame: boolean;
      state: string | null;
      saved: string | null;
      rows: number;
      sections: number;
    }>,
    animationSamples: [] as ReloadAnimationSample[],
    animationProbeMs: 0,
    animationPolicy:
      "Recognized skeleton shimmer or opacity/visibility-only fades with at most 64 elements; fades containing images, canvas, video or iframes are excluded. Signatures retain content, attributes, appearance and geometry, except intermediate opacity. No whole-page animation mask.",
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
  if (traceIndexedDb) {
    for (const operation of ["get", "getAll", "getAllKeys", "put"] as const) {
      const original = IDBObjectStore.prototype[operation];
      Object.defineProperty(IDBObjectStore.prototype, operation, {
        configurable: true,
        value(this: IDBObjectStore, ...args: unknown[]) {
          const request = Reflect.apply(original, this, args) as IDBRequest;
          if (!data.stopped && this.transaction.db.name === "openclaw-chat-snapshots") {
            const entry: (typeof data.indexedDb)[number] = {
              store: this.name,
              operation,
              atMs: performance.now(),
              completedAtMs: null,
            };
            data.indexedDb.push(entry);
            for (const outcome of ["success", "error"] as const) {
              request.addEventListener(
                outcome,
                () => {
                  entry.completedAtMs = performance.now();
                  entry.outcome = outcome;
                  if (outcome === "success" && operation === "get") {
                    entry.found = request.result !== undefined;
                  }
                },
                { once: true },
              );
            }
          }
          return request;
        },
      });
    }
  }
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
  let domVersion = 0;
  const textObserver = new MutationObserver((records) => {
    domVersion++;
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
  textObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  document.fonts.addEventListener("loadingdone", () => domVersion++);
  const hash = (text: string) => {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++) {
      value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    }
    return (value >>> 0).toString(16);
  };
  const trackedAnimations = new Map<
    Animation,
    {
      target: Element;
      key: string;
      kind: "shimmer" | "fade";
      version?: number;
      value?: ReloadAnimationSample["animations"][number];
    }
  >();
  let nextAnimationId = 0;
  let previousAnimationSample = "";
  const sampleAnimations = () => {
    const started = performance.now();
    for (const animation of document.getAnimations()) {
      if (
        trackedAnimations.has(animation) ||
        !(animation.effect instanceof KeyframeEffect) ||
        !(animation.effect.target instanceof Element)
      ) {
        continue;
      }
      const target = animation.effect.target;
      const properties = new Set(
        animation.effect
          .getKeyframes()
          .flatMap((frame) =>
            Object.keys(frame).filter(
              (key) => !["offset", "computedOffset", "easing", "composite"].includes(key),
            ),
          ),
      );
      const shimmer =
        animation instanceof CSSAnimation &&
        /shimmer/u.test(animation.animationName) &&
        /skeleton/u.test(target.className);
      const fade =
        properties.size > 0 &&
        [...properties].every((key) => key === "opacity" || key === "visibility");
      if (
        (!shimmer && !fade) ||
        target.querySelectorAll("*").length > 63 ||
        target.matches("img,canvas,video,iframe") ||
        target.querySelector("img,canvas,video,iframe")
      ) {
        continue;
      }
      trackedAnimations.set(animation, {
        target,
        key: hash(`${performance.timeOrigin}:${nextAnimationId++}`),
        kind: shimmer ? "shimmer" : "fade",
      });
    }
    const animations: ReloadAnimationSample["animations"] = [];
    for (const [animation, tracked] of trackedAnimations) {
      if (!tracked.target.isConnected) {
        trackedAnimations.delete(animation);
        continue;
      }
      const active = animation.playState === "running" || animation.pending;
      if (!tracked.value || active || tracked.value.active || tracked.version !== domVersion) {
        const elements = [tracked.target, ...tracked.target.querySelectorAll("*")];
        const box = tracked.target.getBoundingClientRect();
        const appearance = elements
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              [rect.x, rect.y, rect.width, rect.height].map((value) => value.toFixed(2)).join(",") +
              [
                style.display,
                style.visibility,
                Number(style.opacity) > 0,
                style.color,
                style.backgroundColor,
                style.backgroundImage,
                style.font,
                style.letterSpacing,
                style.lineHeight,
                style.textDecoration,
                style.borderColor,
                style.borderWidth,
                style.borderRadius,
                style.padding,
                style.boxShadow,
                style.filter,
                style.outline,
                style.fill,
                style.stroke,
              ].join(";")
            );
          })
          .join("|");
        tracked.value = {
          name: tracked.kind,
          key: tracked.key,
          signature: hash(tracked.target.outerHTML + appearance),
          kind: tracked.kind,
          active,
          x: Math.floor(box.x),
          y: Math.floor(box.y),
          width: Math.ceil(box.width),
          height: Math.ceil(box.height),
        };
        tracked.version = domVersion;
      }
      animations.push(tracked.value);
    }
    const serialized = JSON.stringify(animations);
    if (serialized !== previousAnimationSample) {
      data.animationSamples.push({ atMs: performance.now(), animations });
      previousAnimationSample = serialized;
    }
    data.animationProbeMs += performance.now() - started;
  };
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
    Reflect.get(window, "__paneChrome").sample(performance.now());
    sampleAnimations();
    const rowElements = [...document.querySelectorAll(".chat-virtual-row")];
    const rows = rowElements.length;
    const sidebarRowElements = [
      ...document.querySelectorAll("openclaw-app-sidebar [data-session-key]"),
    ];
    const sidebarRows = sidebarRowElements.length;
    const board = Boolean(document.querySelector("openclaw-board-view iframe"));
    const sidebar = document.querySelector("aside.sidebar");
    data.sidebarFrames.push({
      atMs: performance.now(),
      host: Boolean(document.querySelector("openclaw-app-sidebar")),
      frame: Boolean(sidebar),
      state: sidebar?.getAttribute("data-snapshot-state") ?? null,
      saved: sidebar?.getAttribute("data-snapshot-saved") ?? null,
      rows: new Set(sidebarRowElements.map((row) => row.getAttribute("data-session-key"))).size,
      sections: document.querySelectorAll("openclaw-app-sidebar [data-session-section]").length,
    });
    if (document.querySelector("openclaw-app-shell")) {
      data.firstAppDomMs ??= performance.now();
    }
    const visibleTranscriptRows = rowElements.filter((row) => {
      const box = row.getBoundingClientRect();
      return (
        box.bottom > 0 &&
        box.y < innerHeight &&
        box.width > 0 &&
        row.checkVisibility({ checkOpacity: true, visibilityProperty: true }) &&
        Boolean(row.querySelector(".chat-text")?.textContent?.trim())
      );
    });
    if (visibleTranscriptRows.length > 0) {
      data.firstTranscriptDomMs ??= performance.now();
    }
    if (
      visibleTranscriptRows.some(
        (row) => row.closest("[data-region]")?.getAttribute("data-region") === "main",
      )
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
