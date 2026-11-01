import type { MediaFetchAttempt } from "./control-ui-media-errors.ts";

export type MediaSnapshot = {
  nonce: string;
  nativeLayoutShiftSupported: boolean;
  layoutShiftSum: number | null;
  mediaAttributedShiftSum: number | null;
  maxSessionWindowShift: number | null;
  shifts: Array<{
    timestamp: number;
    value: number;
    sources: Array<{ node: string; media: boolean; previous: number[]; current: number[] }>;
  }>;
  blobs: Array<{ source: string; revoked: boolean; live: boolean; attached: boolean }>;
};
type GeometryNode = {
  id: number;
  node: string;
  rowKey: string | null;
  rect: number[];
  visible: boolean;
  scroll: number[];
  image?: { complete: boolean; naturalWidth: number; naturalHeight: number };
};
type GeometryCapture = {
  timestamp: number;
  viewport: number[];
  nodes: GeometryNode[];
};
export type GeometryReport = {
  before: GeometryCapture;
  after: GeometryCapture;
  frames: number;
  changes: Array<{
    timestamp: number;
    id: number;
    node: string;
    rowKey: string | null;
    previous: number[] | null;
    current: number[] | null;
  }>;
};
type MediaBenchObserver = {
  readFetches(): MediaFetchAttempt[];
  reset(): void;
  startGeometry(): void;
  stopGeometry(): GeometryReport;
  read(): MediaSnapshot;
};

declare global {
  interface Window {
    controlUiMediaBench: MediaBenchObserver;
  }
}

// Serialized into each benchmark document; all runtime dependencies stay inside this function.
export function installControlUiMediaObserver(): void {
  const sources = new WeakMap<Blob, string>();
  const blobs = new Map<string, { source: string; revoked: boolean }>();
  const fetchAttempts: MediaFetchAttempt[] = [];
  const authorizationContexts = new Map<string, number>();
  const fetch = window.fetch;
  window.fetch = async (...args) => {
    const [input, init] = args;
    const request = input instanceof Request ? input : undefined;
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    let attempt: MediaFetchAttempt | undefined;
    if (
      /\/(?:__openclaw__\/(?:assistant-media|link-favicon)|api\/users\/[^/]+\/avatar)/u.test(
        url.pathname,
      )
    ) {
      const authorization =
        new Headers(init?.headers ?? request?.headers).get("authorization") ?? "";
      if (!authorizationContexts.has(authorization)) {
        authorizationContexts.set(authorization, authorizationContexts.size + 1);
      }
      attempt = {
        url: url.href,
        method: init?.method ?? request?.method ?? "GET",
        cache: init?.cache ?? request?.cache ?? "default",
        mode: init?.mode ?? request?.mode ?? "cors",
        credentials: init?.credentials ?? request?.credentials ?? "same-origin",
        authorizationContext: authorizationContexts.get(authorization)!,
        outcome: "pending",
      };
      fetchAttempts.push(attempt);
    }
    let response: Response;
    try {
      response = await fetch(...args);
    } catch (error) {
      if (attempt) {
        attempt.outcome = "rejected";
      }
      throw error;
    }
    if (attempt) {
      attempt.outcome = "fulfilled";
      attempt.status = response.status;
    }
    const readBlob = response.blob.bind(response);
    response.blob = async () => {
      const blob = await readBlob();
      sources.set(blob, response.url);
      return blob;
    };
    return response;
  };
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    blobs.set(url, {
      source: blob instanceof Blob ? (sources.get(blob) ?? "unclassified") : "MediaSource",
      revoked: false,
    });
    return url;
  };
  URL.revokeObjectURL = (url) => {
    const entry = blobs.get(url);
    if (entry) {
      entry.revoked = true;
    }
    revoke(url);
  };
  let shifts: MediaSnapshot["shifts"] = [];
  const nonce = crypto.randomUUID();
  const nativeLayoutShiftSupported =
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("layout-shift");
  const recordShifts = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      const shift = entry as PerformanceEntry & {
        hadRecentInput: boolean;
        value: number;
        sources: Array<{
          node?: Node;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }>;
      };
      if (!shift.hadRecentInput) {
        shifts.push({
          timestamp: shift.startTime,
          value: shift.value,
          sources: shift.sources.map(({ node, previousRect, currentRect }) => ({
            node: node instanceof Element ? `${node.tagName}.${node.className}` : "detached",
            media:
              node instanceof Element &&
              (node.matches("img,picture,.chat-message-avatar-anchor") ||
                Boolean(node.querySelector("img,picture"))),
            previous: [previousRect.x, previousRect.y, previousRect.width, previousRect.height],
            current: [currentRect.x, currentRect.y, currentRect.width, currentRect.height],
          })),
        });
      }
    }
  };
  const observer = nativeLayoutShiftSupported
    ? new PerformanceObserver((list) => recordShifts(list.getEntries()))
    : undefined;
  observer?.observe({ type: "layout-shift", buffered: true });
  let geometryFrame = 0;
  let frameCount = 0;
  let nextNodeId = 0;
  const nodeIds = new WeakMap<Element, number>();
  let previousGeometry = new Map<number, GeometryNode>();
  let geometryChanges: GeometryReport["changes"] = [];
  let beforeGeometry: GeometryCapture | undefined;
  const describe = (element: Element): GeometryNode => {
    let id = nodeIds.get(element);
    if (id === undefined) {
      id = ++nextNodeId;
      nodeIds.set(element, id);
    }
    const bounds = element.getBoundingClientRect();
    const rect = [bounds.x, bounds.y, bounds.width, bounds.height];
    let top = Math.max(0, bounds.top);
    let bottom = Math.min(innerHeight, bounds.bottom);
    let left = Math.max(0, bounds.left);
    let right = Math.min(innerWidth, bounds.right);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === "visible" && style.overflowY === "visible") {
        continue;
      }
      const clip = parent.getBoundingClientRect();
      if (style.overflowY !== "visible") {
        top = Math.max(top, clip.top + parent.clientTop);
        bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
      }
      if (style.overflowX !== "visible") {
        left = Math.max(left, clip.left + parent.clientLeft);
        right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
      }
    }
    return {
      id,
      node: `${element.tagName}.${element.getAttribute("class") ?? ""}`,
      rowKey: element.closest("[data-chat-row-key]")?.getAttribute("data-chat-row-key") ?? null,
      rect,
      visible: bottom > top && right > left && !element.closest("[inert]"),
      scroll: [element.scrollLeft, element.scrollTop, element.scrollWidth, element.scrollHeight],
      ...(element instanceof HTMLImageElement
        ? {
            image: {
              complete: element.complete,
              naturalWidth: element.naturalWidth,
              naturalHeight: element.naturalHeight,
            },
          }
        : {}),
    };
  };
  const capture = (): GeometryCapture => ({
    timestamp: performance.now(),
    viewport: [innerWidth, innerHeight, scrollX, scrollY],
    nodes: [...document.querySelectorAll("*")].map(describe),
  });
  const sampleGeometry = () => {
    const timestamp = performance.now();
    const current = new Map<number, GeometryNode>();
    for (const element of document.querySelectorAll(
      ".chat-thread [data-chat-row-key], .chat-thread .chat-group, .chat-thread img, .chat-thread .chat-image-frame, .chat-thread .chat-group-footer, .chat-thread .chat-group-footer *",
    )) {
      const node = describe(element);
      const previous = previousGeometry.get(node.id);
      current.set(node.id, node);
      if (
        (node.visible || previous?.visible) &&
        (!previous || node.rect.some((value, index) => value !== previous.rect[index]))
      ) {
        geometryChanges.push({
          timestamp,
          id: node.id,
          node: node.node,
          rowKey: node.rowKey,
          previous: previous?.rect ?? null,
          current: node.rect,
        });
      }
    }
    for (const [id, previous] of previousGeometry) {
      if (previous.visible && !current.has(id)) {
        geometryChanges.push({
          timestamp,
          id,
          node: previous.node,
          rowKey: previous.rowKey,
          previous: previous.rect,
          current: null,
        });
      }
    }
    previousGeometry = current;
    frameCount += 1;
  };
  const sampleFrame = () => {
    sampleGeometry();
    geometryFrame = requestAnimationFrame(sampleFrame);
  };
  window.controlUiMediaBench = {
    readFetches: () => fetchAttempts,
    reset: () => {
      observer?.takeRecords();
      shifts = [];
    },
    startGeometry: () => {
      beforeGeometry = capture();
      sampleGeometry();
      // Initial geometry establishes the baseline; it is not a change.
      geometryChanges = [];
      frameCount = 0;
      geometryFrame = requestAnimationFrame(sampleFrame);
    },
    stopGeometry: (): GeometryReport => {
      cancelAnimationFrame(geometryFrame);
      sampleGeometry();
      return {
        before: beforeGeometry!,
        after: capture(),
        frames: frameCount,
        changes: geometryChanges,
      };
    },
    read: () => {
      if (observer) {
        recordShifts(observer.takeRecords());
      }
      let layoutShiftSum = 0;
      let mediaAttributedShiftSum = 0;
      let maxSessionWindowShift = 0;
      let windowSum = 0;
      let windowStart = 0;
      let previousShift: number | undefined;
      for (const shift of shifts) {
        if (
          previousShift === undefined ||
          shift.timestamp - previousShift >= 1_000 ||
          shift.timestamp - windowStart >= 5_000
        ) {
          windowStart = shift.timestamp;
          windowSum = 0;
        }
        previousShift = shift.timestamp;
        windowSum += shift.value;
        maxSessionWindowShift = Math.max(maxSessionWindowShift, windowSum);
        layoutShiftSum += shift.value;
        if (shift.sources.some((source) => source.media)) {
          mediaAttributedShiftSum += shift.value;
        }
      }
      return {
        nonce,
        nativeLayoutShiftSupported,
        shifts,
        layoutShiftSum: nativeLayoutShiftSupported ? layoutShiftSum : null,
        mediaAttributedShiftSum: nativeLayoutShiftSupported ? mediaAttributedShiftSum : null,
        maxSessionWindowShift: nativeLayoutShiftSupported ? maxSessionWindowShift : null,
        blobs: [...blobs].map(([url, entry]) =>
          Object.assign({}, entry, {
            live: !entry.revoked,
            attached: [...document.images].some((image) => image.src === url),
          }),
        ),
      };
    },
  };
}
