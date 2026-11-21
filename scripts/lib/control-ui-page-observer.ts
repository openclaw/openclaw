import type { Page } from "playwright";

export type ControlUiPageObservation = {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  longTasksSupported: boolean;
  longTaskCount: number | null;
  longTaskTotalMs: number | null;
  longestLongTaskMs: number | null;
  layoutShiftsSupported: boolean;
  layoutShiftCount: number | null;
  cls: number | null;
  allShiftSum: number | null;
  nonRecentInputShiftSum: number | null;
  layoutShiftSources: Array<{
    at: number;
    value: number;
    hadRecentInput: boolean;
    nodes: Array<{
      tag: string;
      classes: string;
      rowKey: string | null;
      ancestors: string[];
      before: number[];
      after: number[];
    }>;
  }>;
  elementsBefore: number;
  elementsAfter: number;
  assets: Array<{
    name: string;
    startMs: number;
    requestMs: number;
    responseMs: number;
    endMs: number;
    protocol: string;
    encodedBodyBytes: number;
    transferBytes: number;
    completedByReady: boolean | null;
  }>;
  assetRequests: number;
  assetRequestsCompletedByReady: number | null;
  assetEncodedBytesCompletedByReady: number | null;
  /** Six-connection HTTP/1.1 capacity floor, not measured dependency depth. */
  http1AssetConnectionWavesByReady: number | null;
};

type PageObserver = {
  reset(): number;
  finish(): number;
  read(
    actionStartedAt?: number,
    readyAt?: number,
    assetStartedAt?: number,
  ): ControlUiPageObservation;
};

declare global {
  interface Window {
    openclawPageBenchmarkObserver?: PageObserver;
  }
}

/** Serialized into the page; keep runtime dependencies inside this function. */
function installPageObserverInBrowser() {
  if (window.openclawPageBenchmarkObserver) {
    return;
  }
  type Shift = PerformanceEntry & {
    value: number;
    hadRecentInput: boolean;
    sources: Array<{
      node: Node | null;
      previousRect: DOMRectReadOnly;
      currentRect: DOMRectReadOnly;
    }>;
  };
  const supported = PerformanceObserver.supportedEntryTypes;
  const longTasksSupported = supported.includes("longtask");
  const layoutShiftsSupported = supported.includes("layout-shift");
  const tasks: PerformanceEntry[] = [];
  const shifts: Array<{
    startTime: number;
    value: number;
    hadRecentInput: boolean;
    nodes: ControlUiPageObservation["layoutShiftSources"][number]["nodes"];
  }> = [];
  const taskObserver = longTasksSupported
    ? new PerformanceObserver((list) => tasks.push(...list.getEntries()))
    : undefined;
  const collectShifts = (entries: PerformanceEntry[]) => {
    // The Layout Instability entry contract supplies value and hadRecentInput.
    // Capture identity at delivery: virtual rows may retire before the report is read.
    for (const shift of entries as Shift[]) {
      shifts.push({
        startTime: shift.startTime,
        value: shift.value,
        hadRecentInput: shift.hadRecentInput,
        nodes: shift.sources.map(({ node, previousRect: before, currentRect: after }) => {
          const element = node instanceof Element ? node : node?.parentElement;
          const ancestors: string[] = [];
          for (
            let parent = element;
            parent && ancestors.length < 6;
            parent = parent.parentElement
          ) {
            ancestors.push(`${parent.localName}.${[...parent.classList].join(".")}`);
          }
          return {
            tag: node?.nodeName ?? "removed",
            classes: node instanceof Element ? (node.getAttribute("class") ?? "") : "",
            rowKey:
              element?.closest("[data-virtual-row-key]")?.getAttribute("data-virtual-row-key") ??
              null,
            ancestors,
            before: [before.x, before.y, before.width, before.height],
            after: [after.x, after.y, after.width, after.height],
          };
        }),
      });
    }
  };
  const shiftObserver = layoutShiftsSupported
    ? new PerformanceObserver((list) => collectShifts(list.getEntries()))
    : undefined;
  taskObserver?.observe({ type: "longtask" });
  shiftObserver?.observe({ type: "layout-shift" });
  let startedAt = 0;
  let endedAt: number | undefined;
  let elementsBefore = 0;
  window.openclawPageBenchmarkObserver = {
    reset() {
      taskObserver?.takeRecords();
      shiftObserver?.takeRecords();
      tasks.length = 0;
      shifts.length = 0;
      // Count only at boundaries, before timing, rather than observing hot-list mutations.
      elementsBefore = document.querySelectorAll("*").length;
      endedAt = undefined;
      startedAt = performance.now();
      return startedAt;
    },
    finish() {
      endedAt ??= performance.now();
      return endedAt;
    },
    read(actionStartedAt, readyAt, assetStartedAt) {
      const start = actionStartedAt ?? startedAt;
      // The navigation task starts before its inner asset timestamp; retain it in task/CLS proof.
      const assetStart = assetStartedAt ?? start;
      const end = endedAt ?? performance.now();
      tasks.push(...(taskObserver?.takeRecords() ?? []));
      collectShifts(shiftObserver?.takeRecords() ?? []);
      const inInterval = (entry: { startTime: number }) =>
        entry.startTime >= start && entry.startTime < end;
      const observedTasks = tasks.filter(inInterval);
      const observedShifts = shifts.filter(inInterval);
      // Completed resource entries exclude in-flight requests, as in boot evidence.
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const assets = resources
        .filter(
          (entry) =>
            entry.startTime >= assetStart &&
            entry.startTime < end &&
            entry.responseEnd <= end &&
            /\.(?:m?js|css|woff2?|ttf|otf)$/u.test(new URL(entry.name).pathname),
        )
        .map((entry) => ({
          name: new URL(entry.name).pathname,
          startMs: entry.startTime - assetStart,
          requestMs: entry.requestStart - assetStart,
          responseMs: entry.responseStart - assetStart,
          endMs: entry.responseEnd - assetStart,
          protocol: entry.nextHopProtocol,
          encodedBodyBytes: entry.encodedBodySize,
          transferBytes: entry.transferSize,
          completedByReady: readyAt === undefined ? null : entry.responseEnd <= readyAt,
        }));
      const readyAssets = assets.filter((entry) => entry.completedByReady);
      let cls = 0;
      let windowValue = 0;
      let windowStart = 0;
      let previousShift: number | undefined;
      let nonRecentInputShiftSum = 0;
      for (const shift of observedShifts) {
        if (shift.hadRecentInput) {
          continue;
        }
        if (
          previousShift === undefined ||
          shift.startTime - previousShift >= 1_000 ||
          shift.startTime - windowStart >= 5_000
        ) {
          windowStart = shift.startTime;
          windowValue = 0;
        }
        previousShift = shift.startTime;
        windowValue += shift.value;
        nonRecentInputShiftSum += shift.value;
        cls = Math.max(cls, windowValue);
      }
      return {
        startedAt: start,
        endedAt: end,
        durationMs: end - start,
        longTasksSupported,
        longTaskCount: longTasksSupported ? observedTasks.length : null,
        longTaskTotalMs: longTasksSupported
          ? observedTasks.reduce((total, entry) => total + entry.duration, 0)
          : null,
        longestLongTaskMs: longTasksSupported
          ? Math.max(0, ...observedTasks.map((entry) => entry.duration))
          : null,
        layoutShiftsSupported,
        layoutShiftCount: layoutShiftsSupported ? observedShifts.length : null,
        cls: layoutShiftsSupported ? cls : null,
        allShiftSum: layoutShiftsSupported
          ? observedShifts.reduce((total, shift) => total + shift.value, 0)
          : null,
        nonRecentInputShiftSum: layoutShiftsSupported ? nonRecentInputShiftSum : null,
        layoutShiftSources: observedShifts.map((shift) => ({
          at: shift.startTime - start,
          value: shift.value,
          hadRecentInput: shift.hadRecentInput,
          nodes: shift.nodes,
        })),
        elementsBefore,
        elementsAfter: document.querySelectorAll("*").length,
        assets,
        assetRequests: assets.length,
        assetRequestsCompletedByReady: readyAt === undefined ? null : readyAssets.length,
        assetEncodedBytesCompletedByReady:
          readyAt === undefined
            ? null
            : readyAssets.reduce((total, entry) => total + entry.encodedBodyBytes, 0),
        http1AssetConnectionWavesByReady:
          readyAt !== undefined && readyAssets.every((entry) => entry.protocol === "http/1.1")
            ? Math.ceil(readyAssets.length / 6)
            : null,
      };
    },
  };
}

/** Install before navigation; also supports an already-loaded document. */
export async function installControlUiPageObserver(page: Page) {
  const source = `;(() => { const __name = (fn) => fn; (${installPageObserverInBrowser.toString()})(); })();`;
  await page.addInitScript({ content: source });
  await page.evaluate(source);
}

/** Call before engine measurement so the initial DOM census is outside its CPU interval. */
export async function resetControlUiPageObserver(page: Page) {
  return page.evaluate(() => {
    if (!window.openclawPageBenchmarkObserver) {
      throw new Error("Control UI page observer was not installed");
    }
    return window.openclawPageBenchmarkObserver.reset();
  });
}

/** Freeze the browser-local boundary; collect records after engine measurement stops. */
export async function finishControlUiPageObserver(page: Page) {
  return page.evaluate(() => {
    if (!window.openclawPageBenchmarkObserver) {
      throw new Error("Control UI page observer was not installed");
    }
    return window.openclawPageBenchmarkObserver.finish();
  });
}

export async function readControlUiPageObserver(
  page: Page,
  actionStartedAt?: number,
  readyAt?: number,
  assetStartedAt?: number,
): Promise<ControlUiPageObservation> {
  return page.evaluate(
    ({ start, ready, assetStart }) => {
      if (!window.openclawPageBenchmarkObserver) {
        throw new Error("Control UI page observer was not installed");
      }
      return window.openclawPageBenchmarkObserver.read(start, ready, assetStart);
    },
    { start: actionStartedAt, ready: readyAt, assetStart: assetStartedAt },
  );
}
