type ScheduledCallbackCounts = {
  created: number;
  active: number;
  cancelled: number;
  callbacks: number;
};

export type ControlUiResourceCounts = {
  observers: Record<
    "ResizeObserver" | "IntersectionObserver" | "MutationObserver",
    {
      created: number;
      active: number;
      targets: number;
      callbacks: number;
      observeCalls: number;
      disconnectCalls: number;
    }
  >;
  intervals: ScheduledCallbackCounts;
  timeouts: ScheduledCallbackCounts;
  animationFrames: ScheduledCallbackCounts;
  idleCallbacks: ScheduledCallbackCounts & { supported: boolean };
  opaqueTimers: {
    timeouts: { created: number; cleared: number; unresolved: number };
    intervals: { created: number; cleared: number; active: number };
  };
  schedulingCoverage: {
    callbacksComplete: boolean;
    activeComplete: boolean;
    cancellationsComplete: boolean;
  };
  listeners: { window: number; document: number; mediaQuery: number; fontFaceSet: number };
  listenerCallbacks: { window: number; document: number; mediaQuery: number; fontFaceSet: number };
  /** Same counted EventTarget registrations, grouped by event type and capture phase. */
  listenerTypes: Record<keyof ControlUiResourceCounts["listeners"], Record<string, number>>;
  listenerCallbackTypes: Record<keyof ControlUiResourceCounts["listeners"], Record<string, number>>;
  mediaQueries: number;
};

/** Browser init script; counts registrations without changing visibility or scheduling. */
export function installControlUiResourceCounts() {
  if (window !== window.top) {
    return;
  }
  const counter = () => ({
    created: 0,
    active: 0,
    targets: 0,
    callbacks: 0,
    observeCalls: 0,
    disconnectCalls: 0,
  });
  const scheduledCounter = (): ScheduledCallbackCounts => ({
    created: 0,
    active: 0,
    cancelled: 0,
    callbacks: 0,
  });
  const counts: ControlUiResourceCounts = {
    observers: {
      ResizeObserver: counter(),
      IntersectionObserver: counter(),
      MutationObserver: counter(),
    },
    intervals: scheduledCounter(),
    timeouts: scheduledCounter(),
    animationFrames: scheduledCounter(),
    idleCallbacks: {
      ...scheduledCounter(),
      supported:
        typeof window.requestIdleCallback === "function" &&
        typeof window.cancelIdleCallback === "function",
    },
    opaqueTimers: {
      timeouts: { created: 0, cleared: 0, unresolved: 0 },
      intervals: { created: 0, cleared: 0, active: 0 },
    },
    schedulingCoverage: {
      callbacksComplete: true,
      activeComplete: true,
      cancellationsComplete: true,
    },
    listeners: { window: 0, document: 0, mediaQuery: 0, fontFaceSet: 0 },
    listenerCallbacks: { window: 0, document: 0, mediaQuery: 0, fontFaceSet: 0 },
    listenerTypes: { window: {}, document: {}, mediaQuery: {}, fontFaceSet: {} },
    listenerCallbackTypes: { window: {}, document: {}, mediaQuery: {}, fontFaceSet: {} },
    mediaQueries: 0,
  };
  Object.defineProperty(window, "openclawResourceCounts", {
    value: () => structuredClone(counts),
    configurable: true,
  });
  for (const name of ["ResizeObserver", "IntersectionObserver", "MutationObserver"] as const) {
    const Original = window[name];
    if (!Original) {
      continue;
    }
    Reflect.set(
      window,
      name,
      new Proxy(Original, {
        construct(constructor, args, newTarget) {
          const callback = args[0];
          args[0] = function (this: unknown, ...values: unknown[]) {
            counts.observers[name].callbacks++;
            Reflect.apply(callback, this, values);
          };
          // Native constructors share observe/disconnect; only resize/intersection unobserve.
          // SAFETY: Each constructor in this fixed inventory implements these native methods.
          const observer = Reflect.construct(constructor, args, newTarget) as {
            observe(target: Node, options?: unknown): void;
            unobserve?: (target: Node) => void;
            disconnect(): void;
          };
          const targets = new Set<Node>();
          const observe = observer.observe.bind(observer);
          const disconnect = observer.disconnect.bind(observer);
          const unobserve = observer.unobserve?.bind(observer);
          const total = counts.observers[name];
          total.created++;
          observer.observe = (target, options) => {
            observe(target, options);
            total.observeCalls++;
            if (!targets.has(target)) {
              if (targets.size === 0) {
                total.active++;
              }
              targets.add(target);
              total.targets++;
            }
          };
          observer.disconnect = () => {
            disconnect();
            total.disconnectCalls++;
            if (targets.size) {
              total.active--;
              total.targets -= targets.size;
              targets.clear();
            }
          };
          if (unobserve) {
            observer.unobserve = (target) => {
              unobserve(target);
              if (targets.delete(target)) {
                total.targets--;
                if (targets.size === 0) {
                  total.active--;
                }
              }
            };
          }
          return observer;
        },
      }),
    );
  }

  // The init script runs in a browser, even though this module also has Node types.
  const browser: Window = window;
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const opaqueTimeouts = new Set<number>();
  const opaqueIntervals = new Set<number>();
  const instrumentTimer = (native: Window["setTimeout"], repeating: boolean) =>
    new Proxy(native, {
      apply(schedule, receiver, args) {
        const handler = args[0];
        const pending = repeating ? intervals : timeouts;
        const total = repeating ? counts.intervals : counts.timeouts;
        if (typeof handler !== "function") {
          // Keep string evaluation, directive prologues and native argument coercion unchanged.
          const timer: number = Reflect.apply(schedule, receiver, args);
          counts.schedulingCoverage.callbacksComplete = false;
          counts.schedulingCoverage.activeComplete = false;
          counts.schedulingCoverage.cancellationsComplete = false;
          if (repeating) {
            intervals.add(timer);
            counts.intervals.created++;
            counts.intervals.active = intervals.size;
            opaqueIntervals.add(timer);
            counts.opaqueTimers.intervals.created++;
            counts.opaqueTimers.intervals.active = opaqueIntervals.size;
          } else {
            opaqueTimeouts.add(timer);
            counts.opaqueTimers.timeouts.created++;
            counts.opaqueTimers.timeouts.unresolved = opaqueTimeouts.size;
          }
          return timer;
        }
        args[0] = function (this: unknown, ...values: unknown[]) {
          if (!repeating) {
            pending.delete(timer);
            total.active = pending.size;
          }
          total.callbacks++;
          return Reflect.apply(handler, this, values);
        };
        const timer: number = Reflect.apply(schedule, receiver, args);
        pending.add(timer);
        total.created++;
        total.active = pending.size;
        return timer;
      },
    });
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
  browser.setTimeout = instrumentTimer(browser.setTimeout, false);
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
  browser.setInterval = instrumentTimer(browser.setInterval, true);
  const retireTimer = (timer: number) => {
    for (const [pending, total] of [
      [timeouts, counts.timeouts],
      [intervals, counts.intervals],
    ] as const) {
      if (pending.delete(timer)) {
        total.cancelled++;
        total.active = pending.size;
      }
    }
    if (opaqueTimeouts.delete(timer)) {
      // A string timeout may already have run; this records a clear, not confirmed cancellation.
      counts.opaqueTimers.timeouts.cleared++;
      counts.opaqueTimers.timeouts.unresolved = opaqueTimeouts.size;
    }
    if (opaqueIntervals.delete(timer)) {
      counts.opaqueTimers.intervals.cleared++;
      counts.opaqueTimers.intervals.active = opaqueIntervals.size;
    }
  };
  const instrumentCancel = <T extends (handle: number) => void>(
    native: T,
    retire: (handle: number) => void,
  ): T =>
    new Proxy(native, {
      apply(cancel, receiver, args) {
        const result = Reflect.apply(cancel, receiver, args);
        if (
          typeof args[0] === "number" &&
          Number.isInteger(args[0]) &&
          args[0] >= 0 &&
          args[0] <= 0x7fffffff
        ) {
          retire(args[0]);
        } else if (args[0] !== undefined) {
          // Forward unusual Web IDL handles once, without repeating user-defined coercion.
          counts.schedulingCoverage.activeComplete = false;
          counts.schedulingCoverage.cancellationsComplete = false;
        }
        return result;
      },
    });
  // Browser timeout and interval handles share a pool and either clearer can cancel them.
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
  browser.clearTimeout = instrumentCancel(browser.clearTimeout, retireTimer);
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
  browser.clearInterval = instrumentCancel(browser.clearInterval, retireTimer);

  const frames = new Set<number>();
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
  const requestFrame = browser.requestAnimationFrame;
  browser.requestAnimationFrame = new Proxy(requestFrame, {
    apply(request, receiver, args) {
      const callback = args[0];
      if (typeof callback !== "function") {
        return Reflect.apply(request, receiver, args);
      }
      args[0] = function (this: unknown, ...values: unknown[]) {
        frames.delete(frame);
        counts.animationFrames.active = frames.size;
        counts.animationFrames.callbacks++;
        return Reflect.apply(callback, this, values);
      };
      const frame: number = Reflect.apply(request, receiver, args);
      frames.add(frame);
      counts.animationFrames.created++;
      counts.animationFrames.active = frames.size;
      return frame;
    },
  });
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
  browser.cancelAnimationFrame = instrumentCancel(browser.cancelAnimationFrame, (frame) => {
    if (frames.delete(frame)) {
      counts.animationFrames.cancelled++;
      counts.animationFrames.active = frames.size;
    }
  });
  if (counts.idleCallbacks.supported) {
    const idle = new Set<number>();
    // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
    browser.requestIdleCallback = new Proxy(browser.requestIdleCallback, {
      apply(request, receiver, args) {
        const callback = args[0];
        if (typeof callback !== "function") {
          return Reflect.apply(request, receiver, args);
        }
        args[0] = function (this: unknown, ...values: unknown[]) {
          idle.delete(handle);
          counts.idleCallbacks.active = idle.size;
          counts.idleCallbacks.callbacks++;
          return Reflect.apply(callback, this, values);
        };
        const handle: number = Reflect.apply(request, receiver, args);
        idle.add(handle);
        counts.idleCallbacks.created++;
        counts.idleCallbacks.active = idle.size;
        return handle;
      },
    });
    // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the call receiver through Reflect.apply.
    browser.cancelIdleCallback = instrumentCancel(browser.cancelIdleCallback, (handle) => {
      if (idle.delete(handle)) {
        counts.idleCallbacks.cancelled++;
        counts.idleCallbacks.active = idle.size;
      }
    });
  }

  type Listener = EventListenerOrEventListenerObject;
  type Registration = {
    type: string;
    listener: Listener;
    capture: boolean;
    wrapped: EventListener;
    remove: () => void;
  };
  const trackListeners = (
    target: EventTarget,
    kind: keyof ControlUiResourceCounts["listeners"],
  ) => {
    const entries: Registration[] = [];
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, listener, options) => {
      if (
        (kind === "mediaQuery" && type !== "change") ||
        !listener ||
        (typeof options === "object" && options.signal?.aborted)
      ) {
        return add(type, listener, options);
      }
      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      const existing = entries.find(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
      );
      if (existing) {
        return add(type, existing.wrapped, options);
      }
      const key = `${type}:${capture ? "capture" : "bubble"}`;
      const activeTypes = counts.listenerTypes[kind];
      const callbackTypes = counts.listenerCallbackTypes[kind];
      const signal = typeof options === "object" ? options.signal : undefined;
      const once = typeof options === "object" && options.once;
      const entry: Registration = {
        type,
        listener,
        capture,
        wrapped(event) {
          counts.listenerCallbacks[kind]++;
          callbackTypes[key] = (callbackTypes[key] ?? 0) + 1;
          if (once) {
            entry.remove();
          }
          if (typeof listener === "function") {
            listener.call(this, event);
          } else {
            listener.handleEvent(event);
          }
        },
        remove: () => {
          const index = entries.indexOf(entry);
          if (index >= 0) {
            entries.splice(index, 1);
            counts.listeners[kind]--;
            activeTypes[key] = (activeTypes[key] ?? 0) - 1;
            signal?.removeEventListener("abort", entry.remove);
          }
        },
      };
      add(type, entry.wrapped, options);
      entries.push(entry);
      counts.listeners[kind]++;
      activeTypes[key] = (activeTypes[key] ?? 0) + 1;
      signal?.addEventListener("abort", entry.remove, { once: true });
    };
    target.removeEventListener = (type, listener, options) => {
      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      const entry = entries.find(
        (candidate) =>
          candidate.type === type &&
          candidate.listener === listener &&
          candidate.capture === capture,
      );
      entry?.remove();
      remove(type, entry?.wrapped ?? listener, options);
    };
  };
  trackListeners(window, "window");
  trackListeners(document, "document");
  trackListeners(document.fonts, "fontFaceSet");
  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const media = matchMedia(query);
    trackListeners(media, "mediaQuery");
    counts.mediaQueries++;
    return media;
  };
}

export async function readControlUiResourceCounts(page: import("playwright").Page) {
  return page.evaluate(() => {
    // SAFETY: The matching init script installs this document-scoped reader before navigation.
    const read = Reflect.get(window, "openclawResourceCounts") as () => ControlUiResourceCounts;
    return read();
  });
}
