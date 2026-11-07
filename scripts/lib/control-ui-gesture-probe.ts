import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";

export type GestureInput =
  | "pointermove"
  | "mousemove"
  | "wheel"
  | "touchmove"
  | "selectionchange"
  | "resize"
  | "orientationchange";

export type GestureCounters = {
  inputs: Record<GestureInput, number>;
  trustedInputs: number;
  coalescedPointerEvents: number;
  resizeObserverDeliveries: number;
  resizeObserverEntries: number;
  geometryReadAttempts: number;
};

export type GestureFrame = GestureCounters & {
  /** Native rAF timestamp; counters cover the preceding callback interval. */
  at: number;
  /** The first callback is partial and has no complete frame interval. */
  intervalMs: number | null;
};

export type GestureGeometryRead = { at: number; api: string; stack: string };

export type GestureFrameSummary = {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  over16_7Ms: number;
  over33Ms: number;
};

export type GestureProbeOptions = {
  /** Diagnostic runs only: stack capture changes timing and must be reported separately. */
  geometryReadStacks?: boolean;
  maxGeometryReadSamples?: number;
  /** Safety bound for a hung driver; a truncated recording is not acceptance evidence. */
  maxFrameSamples?: number;
  maxInputSamplesPerKind?: number;
};

export type GestureProbeResult = {
  label: string;
  mode: "timing" | "geometry-diagnostic";
  clock: "requestAnimationFrame callback intervals; not CPU or presentation timestamps";
  startedAt: number;
  stoppedAt: number;
  frames: GestureFrame[];
  frameSamplesDropped: number;
  inputClock: "performance.now() at capture-phase delivery";
  inputTimes: Record<GestureInput, number[]>;
  inputSamplesDropped: number;
  firstPhysicalInputAt: number | null;
  lastPhysicalInputAt: number | null;
  /** Events after the last callback are retained, but are not a complete frame. */
  tail: GestureCounters;
  totals: GestureCounters;
  geometryReads: GestureGeometryRead[];
  geometryReadSamplesDropped: number;
  frameSummary: GestureFrameSummary;
  /** Complete callback intervals intersecting the first-to-last physical input span. */
  activeFrameSummary: GestureFrameSummary;
};

type GestureProbeApi = {
  start(label: string): void;
  stop(): GestureProbeResult;
};

/** Serialized into a fresh benchmark page before app code creates its observers. */
export function installControlUiGestureProbe(options: GestureProbeOptions = {}) {
  const key = "__openclawGestureProbe";
  if (Reflect.has(window, key)) {
    throw new Error("The continuous gesture probe is already installed");
  }
  const newCounters = (): GestureCounters => ({
    inputs: {
      pointermove: 0,
      mousemove: 0,
      wheel: 0,
      touchmove: 0,
      selectionchange: 0,
      resize: 0,
      orientationchange: 0,
    },
    trustedInputs: 0,
    coalescedPointerEvents: 0,
    resizeObserverDeliveries: 0,
    resizeObserverEntries: 0,
    geometryReadAttempts: 0,
  });
  const newInputTimes = (): Record<GestureInput, number[]> => ({
    pointermove: [],
    mousemove: [],
    wheel: [],
    touchmove: [],
    selectionchange: [],
    resize: [],
    orientationchange: [],
  });
  let recording = false;
  let label = "";
  let startedAt = 0;
  let previousFrame: number | undefined;
  let frameRequest = 0;
  let frames: GestureFrame[] = [];
  let frameSamplesDropped = 0;
  let inputTimes = newInputTimes();
  let inputSamplesDropped = 0;
  let firstPhysicalInputAt: number | null = null;
  let lastPhysicalInputAt: number | null = null;
  let pending = newCounters();
  let totals = newCounters();
  let geometryReads: GestureGeometryRead[] = [];
  let geometryReadSamplesDropped = 0;
  const sampleLimit = options.maxGeometryReadSamples ?? 2_000;
  const frameLimit = options.maxFrameSamples ?? 36_000;
  const inputLimit = options.maxInputSamplesPerKind ?? 100_000;

  const recordInput = (event: Event) => {
    if (!recording || !event.isTrusted || (event.type === "resize" && event.target !== window)) {
      return;
    }
    // SAFETY: This callback is registered only for the literal keys in inputs.
    const kind = event.type as GestureInput;
    const deliveredAt = performance.now();
    if (inputTimes[kind].length < inputLimit) {
      inputTimes[kind].push(deliveredAt);
    } else {
      inputSamplesDropped++;
    }
    if (kind === "pointermove" || kind === "wheel" || kind === "touchmove" || kind === "resize") {
      firstPhysicalInputAt ??= deliveredAt;
      lastPhysicalInputAt = deliveredAt;
    }
    pending.inputs[kind]++;
    totals.inputs[kind]++;
    pending.trustedInputs++;
    totals.trustedInputs++;
    if (event.type === "pointermove" && event instanceof PointerEvent) {
      const coalesced = event.getCoalescedEvents?.().length ?? 0;
      pending.coalescedPointerEvents += coalesced;
      totals.coalescedPointerEvents += coalesced;
    }
  };
  for (const kind of Object.keys(pending.inputs)) {
    const target = kind === "resize" || kind === "orientationchange" ? window : document;
    target.addEventListener(kind, recordInput, { capture: true, passive: true });
  }

  // Preserve the native observer and callback contract. No target reads, stacks,
  // allocations, or extra scheduling occur in this timing-path wrapper.
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        if (recording) {
          pending.resizeObserverDeliveries++;
          totals.resizeObserverDeliveries++;
          pending.resizeObserverEntries += entries.length;
          totals.resizeObserverEntries += entries.length;
        }
        callback.call(observer, entries, observer);
      });
    }
  };

  if (options.geometryReadStacks) {
    const recordRead = (api: string) => {
      if (!recording) {
        return;
      }
      pending.geometryReadAttempts++;
      totals.geometryReadAttempts++;
      if (geometryReads.length >= sampleLimit) {
        geometryReadSamplesDropped++;
        return;
      }
      geometryReads.push({ at: performance.now(), api, stack: new Error().stack ?? "" });
    };
    const wrapMethod = (prototype: object, name: string, api: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!descriptor || typeof descriptor.value !== "function") {
        return;
      }
      const original = descriptor.value;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value(this: unknown, ...args: unknown[]) {
          recordRead(api);
          return Reflect.apply(original, this, args);
        },
      });
    };
    const wrapGetter = (prototype: object, name: string, api: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below preserves the measured element's native accessor receiver.
      const original = descriptor?.get;
      if (!descriptor || !original) {
        return;
      }
      Object.defineProperty(prototype, name, {
        ...descriptor,
        get(this: unknown) {
          recordRead(api);
          return Reflect.apply(original, this, []);
        },
      });
    };
    for (const method of ["getBoundingClientRect", "getClientRects"]) {
      wrapMethod(Element.prototype, method, `Element.${method}`);
      wrapMethod(Range.prototype, method, `Range.${method}`);
    }
    for (const property of ["clientWidth", "clientHeight", "scrollWidth", "scrollHeight"]) {
      wrapGetter(Element.prototype, property, `Element.${property}`);
    }
    for (const property of ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft"]) {
      wrapGetter(HTMLElement.prototype, property, `HTMLElement.${property}`);
    }
    wrapMethod(window, "getComputedStyle", "Window.getComputedStyle");
  }

  const frame = (at: number) => {
    if (!recording) {
      return;
    }
    if (frames.length < frameLimit) {
      frames.push({
        at,
        intervalMs:
          previousFrame === undefined ? null : Math.round((at - previousFrame) * 1_000) / 1_000,
        ...pending,
      });
    } else {
      frameSamplesDropped++;
    }
    pending = newCounters();
    previousFrame = at;
    frameRequest = requestAnimationFrame(frame);
  };
  const api: GestureProbeApi = {
    start(nextLabel) {
      if (recording) {
        throw new Error("A continuous gesture probe recording is already active");
      }
      label = nextLabel;
      frames = [];
      frameSamplesDropped = 0;
      inputTimes = newInputTimes();
      inputSamplesDropped = 0;
      firstPhysicalInputAt = null;
      lastPhysicalInputAt = null;
      pending = newCounters();
      totals = newCounters();
      geometryReads = [];
      geometryReadSamplesDropped = 0;
      previousFrame = undefined;
      startedAt = performance.now();
      recording = true;
      frameRequest = requestAnimationFrame(frame);
    },
    stop() {
      if (!recording) {
        throw new Error("No continuous gesture probe recording is active");
      }
      const stoppedAt = performance.now();
      recording = false;
      cancelAnimationFrame(frameRequest);
      const summarize = (selected: GestureFrame[]): GestureFrameSummary => {
        const intervals = selected
          .flatMap(({ intervalMs }) => (intervalMs === null ? [] : [intervalMs]))
          .toSorted((a, b) => a - b);
        const count = intervals.length;
        const middle = Math.floor(count / 2);
        return {
          count,
          medianMs: count
            ? count % 2
              ? intervals[middle]!
              : (intervals[middle - 1]! + intervals[middle]!) / 2
            : null,
          p95Ms: count ? intervals[Math.ceil(count * 0.95) - 1]! : null,
          minMs: intervals[0] ?? null,
          maxMs: intervals.at(-1) ?? null,
          over16_7Ms: intervals.filter((value) => value > 16.7).length,
          over33Ms: intervals.filter((value) => value > 33).length,
        };
      };
      const activeFrames = frames.filter(
        ({ at, intervalMs }) =>
          intervalMs !== null &&
          firstPhysicalInputAt !== null &&
          lastPhysicalInputAt !== null &&
          at >= firstPhysicalInputAt &&
          at - intervalMs <= lastPhysicalInputAt,
      );
      return {
        label,
        mode: options.geometryReadStacks ? "geometry-diagnostic" : "timing",
        clock: "requestAnimationFrame callback intervals; not CPU or presentation timestamps",
        startedAt,
        stoppedAt,
        frames,
        frameSamplesDropped,
        inputClock: "performance.now() at capture-phase delivery",
        inputTimes,
        inputSamplesDropped,
        firstPhysicalInputAt,
        lastPhysicalInputAt,
        tail: pending,
        totals,
        geometryReads,
        geometryReadSamplesDropped,
        frameSummary: summarize(frames),
        activeFrameSummary: summarize(activeFrames),
      };
    },
  };
  Reflect.set(window, key, api);
}

export async function addControlUiGestureProbe(page: Page, options: GestureProbeOptions = {}) {
  await page.addInitScript(installControlUiGestureProbe, options);
}

export async function startControlUiGestureProbe(page: Page, label: string) {
  await page.evaluate((name) => {
    const probe: GestureProbeApi | undefined = Reflect.get(window, "__openclawGestureProbe");
    if (!probe) {
      throw new Error("The continuous gesture probe was not installed before navigation");
    }
    probe.start(name);
  }, label);
}

export async function stopControlUiGestureProbe(page: Page): Promise<GestureProbeResult> {
  return page.evaluate(() => {
    const probe: GestureProbeApi | undefined = Reflect.get(window, "__openclawGestureProbe");
    if (!probe) {
      throw new Error("The continuous gesture probe was not installed before navigation");
    }
    return probe.stop();
  });
}

type GestureTraceSpan = {
  name: string;
  start: number;
  end: number;
  thread: string;
  stackTrace: unknown[] | null;
  stackFieldPresent: boolean;
  elementCount: number | null;
};

/** Summarize a gesture-bounded native trace, separately from untraced frame timing. */
export function summarizeGestureTrace(
  timeline: readonly unknown[],
  engine: "chromium" | "webkit" | "firefox",
  inputCount: number,
) {
  const spans: GestureTraceSpan[] = [];
  const notes = [
    "Caller must bound the trace to the gesture; native trace time is separate from untraced rAF timing.",
    "Only a native Layout stack counts as forced-layout evidence. Script-nested layouts are separate candidates, not a proven forced-layout count; absent stack fields remain unknown.",
    "Geometry-diagnostic captures include read-wrapper stack frames and instrumentation overhead; their timing is not acceptance timing.",
  ];
  const span = (record: Record<string, unknown>, start: number, end: number, thread: string) => {
    const args = asOptionalRecord(record.args);
    const data = asOptionalRecord(args?.data) ?? asOptionalRecord(record.data);
    const begin = asOptionalRecord(args?.beginData);
    const endData = asOptionalRecord(args?.endData);
    const stack = begin?.stackTrace ?? data?.stackTrace ?? record.stackTrace ?? args?.stackTrace;
    const frames = Array.isArray(stack) ? stack : asOptionalRecord(stack)?.callFrames;
    const elements =
      args?.elementCount ?? endData?.elementCount ?? data?.elementCount ?? begin?.elementCount;
    const name = engine === "webkit" ? record.type : record.name;
    if (
      typeof name !== "string" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start
    ) {
      return;
    }
    spans.push({
      name,
      start,
      end,
      thread,
      stackTrace: Array.isArray(frames) ? frames : null,
      stackFieldPresent: Array.isArray(frames),
      elementCount:
        typeof elements === "number" && Number.isFinite(elements) && elements >= 0
          ? elements
          : null,
    });
  };
  if (engine === "webkit") {
    const visit = (value: unknown) => {
      const record = asOptionalRecord(value);
      if (!record) {
        return;
      }
      if (typeof record.startTime === "number" && typeof record.endTime === "number") {
        span(record, record.startTime, record.endTime, "main");
      }
      if (Array.isArray(record.children)) {
        record.children.forEach(visit);
      }
    };
    timeline.forEach(visit);
    notes.push("WebKit Timeline times are application elapsed time, not CPU or presentation time.");
  } else if (engine === "chromium") {
    const records = timeline.flatMap((value) => {
      const record = asOptionalRecord(value);
      if (!record) {
        return [];
      }
      const { pid, tid } = record;
      if (
        typeof pid !== "number" ||
        typeof tid !== "number" ||
        !Number.isSafeInteger(pid) ||
        !Number.isSafeInteger(tid)
      ) {
        throw new Error("Chromium gesture trace requires integer process and thread identifiers");
      }
      return [{ record, thread: `${pid}:${tid}` }];
    });
    const mainThreads = new Set(
      records
        .filter(
          ({ record }) =>
            record.name === "thread_name" &&
            asOptionalRecord(record.args)?.name === "CrRendererMain",
        )
        .map(({ thread }) => thread),
    );
    const stacks = new Map<string, Record<string, unknown>[]>();
    const events = records
      .filter(
        ({ record, thread }) =>
          typeof record.ts === "number" && (!mainThreads.size || mainThreads.has(thread)),
      )
      .toSorted((a, b) => Number(a.record.ts) - Number(b.record.ts));
    for (const { record, thread } of events) {
      if (record.ph === "X" && typeof record.dur === "number") {
        span(record, Number(record.ts), Number(record.ts) + record.dur, thread);
      } else if (record.ph === "B") {
        const stack = stacks.get(thread) ?? [];
        stack.push(record);
        stacks.set(thread, stack);
      } else if (record.ph === "E") {
        const begin = stacks.get(thread)?.pop();
        if (begin) {
          // Blink can emit elementCount only on the E event. Preserve the
          // initiating stack from B while adopting completion payload fields.
          span(
            {
              ...begin,
              args: { ...asOptionalRecord(begin.args), ...asOptionalRecord(record.args) },
            },
            Number(begin.ts),
            Number(record.ts),
            thread,
          );
        }
      }
    }
    if (!mainThreads.size) {
      notes.push("No CrRendererMain metadata was present; counts include supplied trace threads.");
    }
  } else {
    notes.push("Firefox exposes no native style/layout trace through this harness.");
  }

  const available = spans.length > 0;
  const styles = spans.filter((entry) =>
    ["UpdateLayoutTree", "RecalculateStyles"].includes(entry.name),
  );
  const layouts = spans.filter((entry) => entry.name === "Layout");
  const scripts = spans.filter((entry) =>
    ["FunctionCall", "EvaluateScript", "RunMicrotasks", "V8.Execute", "v8.execute"].includes(
      entry.name,
    ),
  );
  const factor = engine === "webkit" ? 1_000 : 1 / 1_000;
  const describeLayout = (layout: GestureTraceSpan) => ({
    atMs: layout.start * factor,
    durationMs: (layout.end - layout.start) * factor,
    stackTrace: layout.stackTrace,
  });
  const forcedLayouts = layouts
    .filter((layout) => Boolean(layout.stackTrace?.length))
    .map(describeLayout);
  const scriptNestedLayouts = layouts
    .filter((layout) =>
      scripts.some(
        (script) =>
          script.thread === layout.thread &&
          script.start <= layout.start &&
          script.end >= layout.end,
      ),
    )
    .map(describeLayout);
  const elementPasses = styles.flatMap((entry) =>
    entry.elementCount === null ? [] : [{ atMs: entry.start * factor, count: entry.elementCount }],
  );
  const nativeStackAvailable = layouts.some((entry) => entry.stackFieldPresent);
  const perInput = (count: number) => (available && inputCount > 0 ? count / inputCount : null);
  return {
    available,
    stylePasses: available ? styles.length : null,
    layoutPasses: available ? layouts.length : null,
    stylePassesPerInput: perInput(styles.length),
    layoutPassesPerInput: perInput(layouts.length),
    elementsRestyled: {
      available: elementPasses.length > 0,
      measuredPasses: elementPasses.length,
      missingPasses: available ? styles.length - elementPasses.length : null,
      total: elementPasses.length ? elementPasses.reduce((sum, pass) => sum + pass.count, 0) : null,
      meanPerMeasuredPass: elementPasses.length
        ? elementPasses.reduce((sum, pass) => sum + pass.count, 0) / elementPasses.length
        : null,
      passes: elementPasses,
    },
    forcedLayoutCount: nativeStackAvailable ? forcedLayouts.length : null,
    nativeLayoutStacksAvailable: nativeStackAvailable,
    layoutsWithStackField: available
      ? layouts.filter((layout) => layout.stackFieldPresent).length
      : null,
    scriptNestingAvailable: scripts.length > 0,
    forcedLayouts,
    scriptNestedLayoutCount: scripts.length > 0 ? scriptNestedLayouts.length : null,
    scriptNestedLayouts,
    notes,
  };
}
