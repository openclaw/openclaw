// Observation only. One listener set per page lifetime; no application scheduling changes.
export function installSameServiceBrowserProbe() {
  const nativeFrame = window.requestAnimationFrame.bind(window);
  const NativeSocket = window.WebSocket;
  let run;
  let composer;
  let request;
  let observedPreview;
  let previewVisibility = "absent";
  const visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === observedPreview) {
        previewVisibility =
          entry.isIntersecting && entry.intersectionRatio > 0 ? "visible" : "offscreen";
      }
    }
  });
  const subscriptions = [];
  const socketFacts = [];
  const latestMarker = (text) => {
    let maximum = -1;
    for (const match of text.matchAll(/output-(\d{6}):/g)) {
      maximum = Math.max(maximum, Number(match[1]));
    }
    return maximum;
  };
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      const fact = { createdAt: performance.now(), state: "connecting" };
      socketFacts.push(fact);
      this.addEventListener("open", () => {
        fact.state = "open";
        fact.openAt = performance.now();
      });
      this.addEventListener("close", () => {
        fact.state = "closed";
        fact.closedAt = performance.now();
      });
      this.addEventListener("error", () => {
        fact.errorAt = performance.now();
      });
      this.addEventListener("message", (event) => {
        if (!run || typeof event.data !== "string") {
          return;
        }
        let packet;
        try {
          packet = JSON.parse(event.data);
        } catch {
          return;
        }
        const payload = packet.payload;
        if (payload?.stream !== "tool") {
          return;
        }
        const output = payload.data;
        if (!run.runId && output?.phase === "start") {
          run.runId = payload.runId;
        }
        if (payload.runId !== run.runId) {
          return;
        }
        const text = output?.partialResult?.liveOutput?.text ?? output?.partialResult?.text ?? "";
        const maxIndex = latestMarker(text);
        const entry = {
          at: performance.now(),
          runId: payload.runId,
          seq: payload.seq,
          toolCallId: output?.toolCallId,
          phase: output?.phase,
          maxIndex,
          outputOnly: output?.outputOnly === true,
        };
        run.frames.push(entry);
        if (output?.phase === "update" && maxIndex >= 0) {
          run.latestDelivered = Math.max(run.latestDelivered, maxIndex);
        }
      });
    }
    send(data) {
      if (typeof data === "string") {
        let packet;
        try {
          packet = JSON.parse(data);
        } catch {
          /* Native send retains validation. */
        }
        if (packet?.method === "sessions.messages.subscribe") {
          subscriptions.push({ at: performance.now(), params: packet.params });
        }
      }
      return super.send(data);
    }
  };
  const thread = () =>
    document.querySelector('openclaw-chat-pane[aria-hidden="false"] .chat-thread');
  const geometry = (target) => ({
    top: target.scrollTop,
    height: target.scrollHeight,
    viewport: target.clientHeight,
    distance: target.scrollHeight - target.clientHeight - target.scrollTop,
  });
  const onKey = (event) => {
    if (!run || event.target !== composer) {
      return;
    }
    run.keys.push({
      at: performance.now(),
      timeStamp: event.timeStamp,
      isTrusted: event.isTrusted,
      focused: document.activeElement === composer,
      type: event.type,
      key: event.key,
    });
  };
  const onInput = (event) => {
    if (!run || event.target !== composer) {
      return;
    }
    const owner = run;
    const key = owner.keys.findLast((entry) => entry.type === "keydown");
    const input = {
      at: performance.now(),
      timeStamp: event.timeStamp,
      keydownAt: key?.at,
      keydownTimeStamp: key?.timeStamp,
      isTrusted: event.isTrusted,
      focused: document.activeElement === composer,
      length: composer.value.length,
      selectionStart: composer.selectionStart,
      selectionEnd: composer.selectionEnd,
      selectionDirection: composer.selectionDirection,
    };
    owner.inputs.push(input);
    queueMicrotask(() => {
      input.microtaskAt = performance.now();
    });
    nativeFrame(() => {
      input.firstFrameAt = performance.now();
      nativeFrame(() => {
        input.secondFrameAt = performance.now();
        input.timestampToCaptureMs = input.at - input.timeStamp;
        input.captureToSecondFrameMs = input.secondFrameAt - input.at;
        input.composerIdentity =
          document.querySelector('openclaw-chat-pane[aria-hidden="false"] textarea') === composer;
        input.focusedAfter = document.activeElement === composer;
        input.lengthAfter = composer.value.length;
        input.selectionStartAfter = composer.selectionStart;
        input.selectionEndAfter = composer.selectionEnd;
      });
    });
  };
  const onWheel = (event) => {
    const target = thread();
    if (!run || !target || !(event.target instanceof Node) || !target.contains(event.target)) {
      return;
    }
    const owner = run;
    const wheel = {
      at: performance.now(),
      timeStamp: event.timeStamp,
      isTrusted: event.isTrusted,
      deltaY: event.deltaY,
      path: event
        .composedPath()
        .filter((node) => node instanceof Element)
        .map((node) => ({
          tag: node.tagName,
          className: node.getAttribute("class"),
        })),
      before: geometry(target),
      focused: document.activeElement === composer,
    };
    owner.wheels.push(wheel);
    nativeFrame(() => {
      wheel.defaultPrevented = event.defaultPrevented;
      wheel.firstFrameAt = performance.now();
      wheel.first = geometry(target);
      nativeFrame(() => {
        wheel.secondFrameAt = performance.now();
        wheel.second = geometry(target);
      });
    });
  };
  // Send replaces its button before EventTiming delivery, so retain the trusted
  // capture timestamp instead of relying on EventTiming's detached target.
  const onClick = (event) => {
    const pane = document.querySelector('openclaw-chat-pane[aria-hidden="false"]');
    if (!run || !(event.target instanceof Element) || !pane?.contains(event.target)) {
      return;
    }
    const button = event.target.closest("button");
    run.clicks.push({
      at: performance.now(),
      timeStamp: event.timeStamp,
      isTrusted: event.isTrusted,
      buttonLabel: button?.getAttribute("aria-label"),
      buttonClass: button?.className,
    });
  };
  const eventTiming = new PerformanceObserver((list) => {
    if (!run) {
      return;
    }
    for (const entry of list.getEntries()) {
      const click =
        entry.name === "click" && run.clicks.some((item) => item.timeStamp === entry.startTime);
      if (entry.target !== composer && !click) {
        continue;
      }
      run.eventTiming.push({
        targetKind: entry.target === composer ? "composer" : "trusted-pane-click",
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
        processingStart: entry.processingStart,
        processingEnd: entry.processingEnd,
        interactionId: entry.interactionId,
      });
    }
  });
  eventTiming.observe({ type: "event", buffered: false, durationThreshold: 16 });
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKey, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("wheel", onWheel, { capture: true, passive: true });
  const tick = (timestamp) => {
    if (!run) {
      return;
    }
    const startedAt = performance.now();
    const pane = document.querySelector('openclaw-chat-pane[aria-hidden="false"]');
    const row = pane?.querySelector(".chat-tool-row--running");
    const preview = row
      ?.closest(".chat-tool-msg-collapse")
      ?.querySelector(".chat-command-trail__preview pre");
    if (preview !== observedPreview) {
      visibilityObserver.disconnect();
      observedPreview = preview;
      previewVisibility = preview ? "pending" : "absent";
      if (preview) {
        visibilityObserver.observe(preview);
      }
    }
    const scrollport = thread();
    if (scrollport) {
      const pending = run.wheels.filter((wheel) => wheel.movementAt === undefined && !wheel.noRoom);
      if (pending.length) {
        const currentTop = scrollport.scrollTop;
        for (const wheel of pending) {
          const remaining = wheel.deltaY < 0 ? wheel.before.top : wheel.before.distance;
          if (remaining < 1) {
            wheel.noRoom = true;
            continue;
          }
          if (
            wheel.deltaY < 0 ? currentTop < wheel.before.top - 1 : currentTop > wheel.before.top + 1
          ) {
            wheel.movementAt = performance.now();
            wheel.movementTop = currentTop;
            wheel.timestampToMovementMs = wheel.movementAt - wheel.timeStamp;
            wheel.captureToMovementMs = wheel.movementAt - wheel.at;
          }
        }
      }
    }
    // Compact preview is bounded by product presentation (three lines); no body/history copy.
    const index = preview ? latestMarker(preview.textContent ?? "") : null;
    const below =
      pane?.querySelector(".chat-scroll-to-bottom")?.getAttribute("data-visible") === "true";
    const observation = {
      at: performance.now(),
      timestamp,
      previewMounted: Boolean(preview),
      index,
      visibility: previewVisibility,
      delivered: run.latestDelivered,
      below,
      focused: document.activeElement === composer,
      composerIdentity: pane?.querySelector("textarea") === composer,
    };
    run.previewFrames.push(observation);
    if (index !== run.lastPreviewIndex) {
      run.previewTransitions.push(observation);
      run.lastPreviewIndex = index;
    }
    run.observerCpuMs += performance.now() - startedAt;
    request = nativeFrame(tick);
  };
  window.sameServiceProbe = {
    begin(turn) {
      if (run) {
        throw new Error("Previous observed turn must finish before begin");
      }
      const current = document.querySelector('openclaw-chat-pane[aria-hidden="false"] textarea');
      if (!current) {
        throw new Error("Expected mounted composer");
      }
      if (composer && composer !== current) {
        throw new Error("Composer DOM identity changed between turns");
      }
      composer = current;
      run = {
        turn,
        startAt: performance.now(),
        latestDelivered: -1,
        lastPreviewIndex: undefined,
        frames: [],
        inputs: [],
        keys: [],
        wheels: [],
        clicks: [],
        eventTiming: [],
        previewFrames: [],
        previewTransitions: [],
        observerCpuMs: 0,
      };
      request = nativeFrame(tick);
      return run.startAt;
    },
    facts() {
      return {
        subscriptions: subscriptions.length,
        socketFacts,
        openSockets: socketFacts.filter((fact) => fact.state === "open").length,
      };
    },
    snapshot() {
      return { run, subscriptions, socketFacts };
    },
    finish() {
      if (!run) {
        throw new Error("No observed turn");
      }
      cancelAnimationFrame(request);
      const result = { ...run, endAt: performance.now() };
      run = undefined;
      return result;
    },
    dispose() {
      cancelAnimationFrame(request);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKey, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("wheel", onWheel, true);
      eventTiming.disconnect();
      visibilityObserver.disconnect();
      observedPreview = undefined;
      window.WebSocket = NativeSocket;
      run = undefined;
      composer = undefined;
      return {
        subscriptions,
        socketFacts,
        openSockets: socketFacts.filter((fact) => fact.state === "open").length,
        listenersRemoved: true,
      };
    },
  };
}
