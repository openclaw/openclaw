// External qualification observation only; reads the existing owner, never changes its state.
export function installInlineCommandOptInProbe() {
  "use strict";
  // Browser evaluation serializes this installer without its module context.
  // Preserve native undefined callback receivers before forwarding them.
  const NativeWeakMap = window.WeakMap;
  // oxlint-disable-next-line typescript/unbound-method -- Save the native method before instrumentation; each invocation explicitly supplies its original target with .call.
  const nativeAdd = EventTarget.prototype.addEventListener;
  // oxlint-disable-next-line typescript/unbound-method -- Save the native method before instrumentation; each invocation explicitly supplies its original target with .call.
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const nativeFrame = window.requestAnimationFrame;
  const nativeMicrotask = window.queueMicrotask;
  const messageFrames = new NativeWeakMap();
  const listenerWrappers = new NativeWeakMap();
  const consumerIds = new NativeWeakMap();
  const consumerSources = [];
  const consumerSourceCaptureSpans = [];
  const consumerSpans = [];
  const consumerIssues = new Set();
  let sourceChars = 0;
  let nextSpanId = 0;
  const prewarm = () => active && !window.inlineNativeProbe?.active;
  const consumerId = (callback) => {
    const existing = consumerIds.get(callback);
    if (existing !== undefined) {
      return existing;
    }
    const startAt = prewarm() ? performance.now() : undefined;
    let id = 0;
    let outcome = "threw";
    try {
      const source = Function.prototype.toString.call(callback);
      const registrationStack = new Error().stack;
      const chars = source.length + (registrationStack?.length ?? 0);
      // Overflow invalidates source evidence; never sample callbacks or silently
      // describe an incomplete buffer as an attributed qualification.
      if (consumerSources.length >= 512 || sourceChars + chars > 1_000_000) {
        consumerIssues.add("consumer-source-buffer-full");
        consumerIds.set(callback, 0);
        outcome = "source-buffer-full";
        return 0;
      }
      sourceChars += chars;
      id = consumerSources.length + 1;
      consumerIds.set(callback, id);
      consumerSources.push({ id, name: callback.name, source, registrationStack });
      outcome = "recorded";
      return id;
    } finally {
      if (startAt !== undefined) {
        // End the measured capture before storing its receipt. This bounded
        // observation adds overhead; it does not claim collector-free timing.
        const endAt = performance.now();
        if (consumerSourceCaptureSpans.length < 512) {
          consumerSourceCaptureSpans.push({ consumerId: id, startAt, endAt, outcome });
        } else {
          consumerIssues.add("consumer-source-capture-span-buffer-full");
        }
      }
    }
  };
  const invokeConsumer = (id, kind, callback, receiver, args) => {
    if (!prewarm()) {
      return Reflect.apply(callback, receiver, args);
    }
    const span = {
      id: ++nextSpanId,
      consumerId: id,
      kind,
      frameId: kind === "WebSocket.message" ? messageFrames.get(args[0])?.frameId : undefined,
      animationTimestamp: kind === "animation-frame" ? args[0] : undefined,
      startAt: performance.now(),
      outcome: "returned",
    };
    try {
      return Reflect.apply(callback, receiver, args);
    } catch (error) {
      span.outcome = "threw";
      throw error;
    } finally {
      span.endAt = performance.now();
      if (consumerSpans.length < 32_768) {
        consumerSpans.push(span);
      } else {
        consumerIssues.add("consumer-span-buffer-full");
      }
    }
  };
  const messageKind = (target, type) =>
    type !== "message"
      ? null
      : target instanceof WebSocket
        ? "WebSocket.message"
        : target instanceof MessagePort
          ? "MessagePort.message"
          : null;
  EventTarget.prototype.addEventListener = function (type, callback, options) {
    const kind = messageKind(this, type);
    // Current product consumers use function listeners. Object listeners and
    // onmessage descriptors retain native behavior and are outside this proof.
    if (!kind || typeof callback !== "function") {
      return nativeAdd.call(this, type, callback, options);
    }
    let byCallback = listenerWrappers.get(this);
    let wrapped = byCallback?.get(callback);
    if (!wrapped && window.inlineNativeProbe?.active) {
      return nativeAdd.call(this, type, callback, options);
    }
    if (!wrapped) {
      const id = consumerId(callback);
      wrapped = function (...args) {
        return invokeConsumer(id, kind, callback, this, args);
      };
      if (!byCallback) {
        byCallback = new NativeWeakMap();
        listenerWrappers.set(this, byCallback);
      }
      byCallback.set(callback, wrapped);
    }
    // Reuse one native identity across capture/once/signal variants. The
    // browser still owns deduplication and retirement; options are not reread.
    return nativeAdd.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (type, callback, options) {
    const wrapped = messageKind(this, type) && listenerWrappers.get(this)?.get(callback);
    return nativeRemove.call(this, type, wrapped || callback, options);
  };
  window.requestAnimationFrame = function (callback) {
    if (typeof callback !== "function" || window.inlineNativeProbe?.active) {
      return nativeFrame.call(this, callback);
    }
    const id = consumerId(callback);
    return nativeFrame.call(this, function (...args) {
      return invokeConsumer(id, "animation-frame", callback, this, args);
    });
  };
  // Solid's scheduled flush runs after the observed dispatch returns. Observe
  // that callback directly without extending its parent span over microtasks.
  window.queueMicrotask = function (callback) {
    if (typeof callback !== "function" || window.inlineNativeProbe?.active) {
      return nativeMicrotask.call(this, callback);
    }
    const id = consumerId(callback);
    return nativeMicrotask.call(this, function (...args) {
      return invokeConsumer(id, "microtask", callback, this, args);
    });
  };
  const registrations = new Map();
  class RegistrationWeakMap extends NativeWeakMap {
    set(state, owner) {
      super.set(state, owner);
      if (state?.toolStreamById instanceof Map && owner?.fields?.includes("chatToolMessages")) {
        registrations.set(state, owner);
      }
      return this;
    }
  }
  window.WeakMap = RegistrationWeakMap;
  const callbacks = [];
  const tasks = [];
  const clickEvents = [];
  const clickEventTimings = [];
  const longAnimationFrames = [];
  const longAnimationFrameSupported =
    PerformanceObserver.supportedEntryTypes.includes("long-animation-frame");
  const eventTimingSupported = PerformanceObserver.supportedEntryTypes.includes("event");
  let observer,
    animationObserver,
    eventObserver,
    request,
    ready,
    sendAt,
    active = false;
  const sendButton = (target) => {
    const button = target instanceof Element ? target.closest("button") : null;
    return button &&
      (button.getAttribute("aria-label") === "Send message" ||
        button.textContent.trim() === "Send message")
      ? button
      : null;
  };
  for (const capture of [true, false]) {
    document.addEventListener(
      "click",
      (event) => {
        if (!active || !sendButton(event.target)) {
          return;
        }
        clickEvents.push({
          at: performance.now(),
          timeStamp: event.timeStamp,
          isTrusted: event.isTrusted,
          capture,
        });
        performance.mark(capture ? "inline-send-capture" : "inline-send-bubble");
      },
      capture,
    );
  }
  const recordAnimationFrames = (entries) => {
    for (const entry of entries) {
      longAnimationFrames.push({
        at: entry.startTime,
        duration: entry.duration,
        blockingDuration: entry.blockingDuration,
        renderStart: entry.renderStart,
        styleAndLayoutStart: entry.styleAndLayoutStart,
        firstUIEventTimestamp: entry.firstUIEventTimestamp,
        scripts: entry.scripts.map((script) => ({
          startTime: script.startTime,
          duration: script.duration,
          executionStart: script.executionStart,
          forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
          pauseDuration: script.pauseDuration,
          invoker: script.invoker,
          invokerType: script.invokerType,
          sourceURL: script.sourceURL,
          sourceFunctionName: script.sourceFunctionName,
          sourceCharPosition: script.sourceCharPosition,
        })),
      });
    }
  };
  const recordEventTimings = (entries) => {
    for (const entry of entries) {
      if (entry.name === "click" && entry.startTime >= sendAt) {
        clickEventTimings.push({
          startTime: entry.startTime,
          duration: entry.duration,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
          interactionId: entry.interactionId,
          sendTarget: Boolean(sendButton(entry.target)),
        });
      }
    }
  };
  const frame = (timestamp) => {
    if (!active) {
      return;
    }
    const state = window.inlineNativeProbe;
    const callback = { timestamp, callbackAt: performance.now(), warm: state.active };
    const previous = callbacks.at(-1);
    callbacks.push(callback);
    if (callback.warm && previous?.warm) {
      state.rafGaps.push({ at: previous.timestamp, duration: timestamp - previous.timestamp });
    }
    if (
      state.active &&
      state.observePreview &&
      state.previewFinalAt === null &&
      document
        .querySelector(".chat-command-trail__preview pre")
        ?.textContent.includes("output-000511:")
    ) {
      state.previewFinalAt = performance.now();
    }
    request = nativeFrame.call(window, frame);
    callback.callbackEndAt = performance.now();
  };
  window.inlineCommandOptInProbe = {
    get active() {
      return active;
    },
    // The existing parsing observer precedes product listeners and pairs the
    // exact same native Event, rather than guessing from adjacent timestamps.
    listenObserver(target, callback) {
      nativeAdd.call(target, "message", callback);
    },
    recordMessageFrame(event, receipt) {
      messageFrames.set(event, receipt);
    },
    start() {
      if (active) {
        throw new Error("Startup observation already active");
      }
      active = true;
      sendAt = performance.mark("inline-startup-start").startTime;
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          tasks.push({ at: entry.startTime, duration: entry.duration });
        }
      });
      observer.observe({ type: "longtask" });
      if (longAnimationFrameSupported) {
        animationObserver = new PerformanceObserver((list) =>
          recordAnimationFrames(list.getEntries()),
        );
        animationObserver.observe({ type: "long-animation-frame" });
      }
      if (eventTimingSupported) {
        eventObserver = new PerformanceObserver((list) => recordEventTimings(list.getEntries()));
        eventObserver.observe({ type: "event", durationThreshold: 16 });
      }
      request = nativeFrame.call(window, frame);
      return sendAt;
    },
    ready(sessionKey, inline) {
      if (ready) {
        return true;
      }
      const matches = [...registrations].filter(([state]) => state.sessionKey === sessionKey);
      if (matches.length !== 1) {
        return false;
      }
      const [state, owner] = matches[0];
      const start = window.inlineNativeProbe.startupFrames.find(
        (event) =>
          event.stream === "tool" &&
          event.phase === "start" &&
          event.toolCallId === "inline-native-output",
      );
      if (!start) {
        return false;
      }
      const identity = JSON.stringify([start.runId, start.toolCallId]);
      const entry = state.toolStreamById.get(identity);
      const published = owner.values.chatToolMessages?.some(
        (message) => message.runId === start.runId && message.toolCallId === start.toolCallId,
      );
      const selector = inline
        ? ".chat-tool-row__cmd"
        : ".chat-activity-group__summary, .chat-tool-row";
      const mounted = document
        .querySelector('openclaw-chat-pane[aria-hidden="false"]')
        ?.querySelector(selector);
      const acceptedSeq = state.activityEventSeqById.get(`tool:${identity}`);
      if (!entry || entry.resultReceived || !published || !mounted || !(acceptedSeq >= start.seq)) {
        return false;
      }
      ready = {
        at: performance.now(),
        selector,
        runId: start.runId,
        toolCallId: start.toolCallId,
        startReceivedAt: start.at,
        startSeq: start.seq,
        acceptedSeq,
        ownerEntry: true,
        published: true,
        mounted: true,
      };
      performance.mark("inline-command-ready");
      return true;
    },
    beginWarm() {
      if (!ready) {
        throw new Error("Warm writes require accepted command start and mounted structure");
      }
      window.WeakMap = NativeWeakMap;
      Object.defineProperty(
        RegistrationWeakMap.prototype,
        "set",
        Object.getOwnPropertyDescriptor(NativeWeakMap.prototype, "set"),
      );
    },
    finish() {
      for (const entry of observer.takeRecords()) {
        tasks.push({ at: entry.startTime, duration: entry.duration });
      }
      observer.disconnect();
      if (animationObserver) {
        recordAnimationFrames(animationObserver.takeRecords());
        animationObserver.disconnect();
      }
      if (eventObserver) {
        recordEventTimings(eventObserver.takeRecords());
        eventObserver.disconnect();
      }
      cancelAnimationFrame(request);
      active = false;
      const state = window.inlineNativeProbe;
      state.tasks = tasks.filter((task) => task.at >= state.startAt);
      performance.mark("inline-startup-end");
      return {
        sendAt,
        ready,
        startupFrames: state.startupFrames,
        frameCallbacks: callbacks,
        tasks,
        clickEvents,
        clickEventTimings,
        eventTimingSupported,
        longAnimationFrames,
        longAnimationFrameSupported,
        consumerObservations: {
          sources: consumerSources,
          sourceCaptureSpans: consumerSourceCaptureSpans,
          spans: consumerSpans,
          issues: [
            ...consumerIssues,
            ...(state.requestJoinOverflow ? ["request-method-buffer-full"] : []),
          ],
          complete: consumerIssues.size === 0 && !state.requestJoinOverflow,
          interpretation:
            "Direct prewarm function-listener WebSocket/MessagePort, application rAF and queueMicrotask callback entry/return/throw spans; identical hooks in all cells. Source/registration receipts are stored once per original callback; direct source-capture spans cover first-time prewarm capture and registration bookkeeping, ending before receipt storage. ID reuse and captures outside prewarm have no capture span. Original microtask scheduling and ordering remain native; no Promise reactions, task deferrals or scheduling barriers are added. Return does not bracket descendant microtasks or native work. Object listeners, onmessage properties and Promise callbacks are unmodified and unobserved. Recording stops at warm activation, but persistent listener wrappers retain common invocation overhead; timing and bounded receipt storage also add overhead. This is not an overhead-free observation. Buffer overflow invalidates attribution completeness.",
        },
        endAt: performance.now(),
        warmStartAt: state.startAt,
        interpretation:
          "One continuous observation from before Send through warm end. Capture/bubble click entries bound dispatch, not handler self-time. Event Timing has a 16ms floor and asynchronous delivery. Supported long-animation-frame entries retain script attribution; missing entries do not establish absence of work. Animation timestamps, callback entry/exit and lag remain separate. Readiness reads the existing owner and mounted structure; initial work stays outside warm CPU.",
      };
    },
  };
}
