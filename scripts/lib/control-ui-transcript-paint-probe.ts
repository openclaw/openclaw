/** Capture-only probe. Never use its layout reads or paint markers for CPU proof. */
export function observeTranscriptPaint() {
  const thread = document.querySelector<HTMLElement>(
    ".chat-pane-cache__pane--active .chat-thread",
  )!;
  if (!thread) {
    throw new Error("Paint probe needs the active transcript");
  }
  const inner = thread.querySelector<HTMLElement>(".chat-thread-inner");
  const block = thread.querySelector<HTMLElement>(".chat-virtual-block");
  if (!inner || !block) {
    throw new Error("Paint probe needs the virtualized transcript");
  }
  const marker = document.createElement("canvas");
  const context = marker.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Paint probe needs a 2D canvas context");
  }
  const samples: unknown[] = [];
  const input: unknown[] = [];
  const frames: unknown[] = [];
  const properties = [
    "background-image",
    "background-size",
    "background-position",
    "background-repeat",
    "background-attachment",
    "background-origin",
    "background-clip",
  ];
  const saved = properties.map((key) => [
    key,
    thread.style.getPropertyValue(key),
    thread.style.getPropertyPriority(key),
  ]);
  const restoreBackground = () => {
    for (const [key, value, priority] of saved) {
      thread.style.setProperty(key!, value!, priority);
    }
  };
  const originalGeometry = [thread.clientWidth, thread.clientHeight, thread.scrollHeight];
  const bits = 18,
    stripWidth = 6,
    quantum = 4;
  thread.style.backgroundImage = Array(bits)
    .fill("linear-gradient(to bottom,#000 0 50%,#fff 50% 100%)")
    .join(",");
  thread.style.backgroundSize = Array.from(
    { length: bits },
    (_, bit) => `${stripWidth}px ${quantum * 2 ** (bit + 1)}px`,
  ).join(",");
  thread.style.backgroundPosition = Array.from(
    { length: bits },
    (_, bit) => `${stripWidth * bit}px 0px`,
  ).join(",");
  thread.style.backgroundRepeat = Array(bits).fill("repeat-y").join(",");
  thread.style.backgroundAttachment = Array(bits).fill("local").join(",");
  thread.style.backgroundOrigin = "padding-box";
  thread.style.backgroundClip = "padding-box";
  if (
    [thread.clientWidth, thread.clientHeight, thread.scrollHeight].some(
      (value, index) => value !== originalGeometry[index],
    )
  ) {
    restoreBackground();
    throw new Error("Paint ruler changed scroll geometry");
  }
  marker.width = 120;
  marker.height = 12;
  Object.assign(marker.style, {
    position: "fixed",
    left: "0",
    bottom: "0",
    width: "120px",
    height: "12px",
    pointerEvents: "none",
    zIndex: "2147483647",
    contain: "strict",
  });
  marker.setAttribute("aria-hidden", "true");
  document.body.append(marker);
  type Item = { index: number; key: string | number; start: number; end: number; size: number };
  type Snapshot = {
    virtualizer: {
      range: { startIndex: number; endIndex: number } | null;
      scrollOffset: number | null;
      measurementsCache: Item[];
      itemSizeCache: Map<string | number, number>;
    };
    activeRowKeys: Set<string>;
    preparingRowKey?: string;
  };
  let renderer: object | undefined;
  const previousHook = Object.getOwnPropertyDescriptor(window, "openclawRenderLifecycleTestHook");
  const hook = Reflect.get(window, "openclawRenderLifecycleTestHook");
  Object.defineProperty(window, "openclawRenderLifecycleTestHook", {
    configurable: true,
    value: (host: object, phase: string) => {
      if (Reflect.get(host, "element") === inner && Reflect.get(host, "accepted")) {
        renderer = host;
      }
      if (typeof hook === "function") {
        Reflect.apply(hook, window, [host, phase]);
      }
    },
  });
  let stopped = false,
    queued = false,
    raf = 0,
    totalMs = 0,
    maxMs = 0,
    dropped = 0;
  const paintId = (id: number) => {
    context.fillStyle = "#000";
    context.fillRect(0, 0, 120, 12);
    context.fillStyle = "#fff";
    context.fillRect(6, 0, 6, 12);
    context.fillRect(114, 0, 6, 12);
    for (let bit = 0; bit < 16; bit++) {
      if (id & (1 << bit)) {
        context.fillRect((bit + 2) * 6, 0, 6, 12);
      }
    }
  };
  const sample = (source: string) => {
    if (stopped) {
      return;
    }
    if (samples.length >= 6000) {
      dropped++;
      paintId(0);
      return;
    }
    const at = performance.now(),
      viewport = thread.getBoundingClientRect(),
      offset = thread.scrollTop;
    // Read stored facts only: getVirtualItems/calculateRange mutate virtual-core memo dependencies.
    // SAFETY: The fixture hook supplies ChatTranscriptRenderer. Its active keys are
    // committed, but its virtualizer is live; copy both facts in this synchronous sample.
    const snapshot = renderer
      ? (Reflect.get(renderer, "committed") as Snapshot | undefined)
      : undefined;
    const view = snapshot?.virtualizer;
    const ancestors = [
      thread,
      inner,
      thread.querySelector<HTMLElement>(".chat-virtual-block")!,
    ].map((element) => {
      const style = getComputedStyle(element);
      return {
        className: element.className,
        opacity: style.opacity,
        visibility: style.visibility,
        display: style.display,
        transform: style.transform,
        clip: style.clip,
        clipPath: style.clipPath,
      };
    });
    const rows = [...thread.querySelectorAll<HTMLElement>(".chat-virtual-row")].map((row) => {
      const index = Number(row.dataset.index),
        key = row.dataset.virtualRowKey;
      const model = view?.measurementsCache[index];
      const style = getComputedStyle(row),
        rect = row.getBoundingClientRect();
      const hidden =
        style.display === "none" ||
        style.opacity === "0" ||
        style.visibility !== "visible" ||
        style.contentVisibility === "hidden";
      const textRects: number[][] | null =
        !hidden && rect.bottom > viewport.top && rect.top < viewport.bottom ? [] : null;
      const textHiddenBy: string[] = [];
      // Offscreen forecasts must not pay forced text layout just for this probe.
      // Null records omitted geometry, distinct from a measured row with no text.
      if (textRects) {
        for (const text of row.querySelectorAll<HTMLElement>(".chat-text")) {
          let textHidden = false;
          for (
            let ancestor: HTMLElement | null = text;
            ancestor && ancestor !== row;
            ancestor = ancestor.parentElement
          ) {
            const textStyle = getComputedStyle(ancestor);
            if (
              textStyle.opacity === "0" ||
              textStyle.visibility !== "visible" ||
              textStyle.display === "none" ||
              textStyle.contentVisibility === "hidden"
            ) {
              textHidden = true;
              textHiddenBy.push(ancestor.className);
              break;
            }
          }
          if (textHidden) {
            continue;
          }
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT),
            range = document.createRange();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) {
              continue;
            }
            range.selectNodeContents(node);
            for (const part of range.getClientRects()) {
              if (part.width > 0 && part.height > 0) {
                textRects.push([
                  part.left,
                  part.top + offset - viewport.top,
                  part.width,
                  part.height,
                ]);
              }
            }
          }
        }
      }
      return {
        key,
        index,
        prepared: row.dataset.preparedRow === "true",
        preparing: row.dataset.preparingRow === "true",
        measured: model ? view?.itemSizeCache.has(model.key) : null,
        model: model ? { start: model.start, end: model.end, size: model.size } : null,
        top: rect.top + offset - viewport.top,
        left: rect.left,
        height: rect.height,
        width: rect.width,
        style: {
          display: style.display,
          opacity: style.opacity,
          visibility: style.visibility,
          position: style.position,
          contentVisibility: style.contentVisibility,
          clip: style.clip,
          clipPath: style.clipPath,
          transform: style.transform,
          contain: style.contain,
        },
        textRects,
        textHiddenBy,
      };
    });
    const id = samples.length + 1;
    samples.push({
      id,
      at,
      source,
      scrollTop: offset,
      scrollHeight: thread.scrollHeight,
      range: view?.range ? { ...view.range } : null,
      ownerOffset: view?.scrollOffset,
      activeKeys: snapshot ? [...snapshot.activeRowKeys] : null,
      preparingKey: snapshot?.preparingRowKey,
      viewport: {
        left: viewport.left,
        top: viewport.top,
        right: viewport.right,
        bottom: viewport.bottom,
      },
      ancestors,
      rows,
    });
    frames.push({
      at,
      scrollTop: offset,
      viewportLeft: viewport.left,
      viewportTop: viewport.top,
      viewportRight: viewport.right,
      viewportBottom: viewport.bottom,
      bubbles: [],
    });
    paintId(id);
    Object.assign(samples.at(-1)!, { markerPublishedAt: performance.now() });
    const duration = performance.now() - at;
    totalMs += duration;
    maxMs = Math.max(maxMs, duration);
  };
  const observer = new MutationObserver(() => {
    if (queued) {
      return;
    }
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sample("mutation");
    });
  });
  observer.observe(inner, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-prepared-row", "data-preparing-row", "data-row-size"],
  });
  const tick = () => {
    sample("raf");
    raf = requestAnimationFrame(tick);
  };
  const onWheel = (event: WheelEvent) =>
    input.push({
      at: performance.now(),
      type: "wheel",
      trusted: event.isTrusted,
      deltaY: event.deltaY,
    });
  thread.addEventListener("wheel", onWheel, { passive: true });
  sample("initial");
  raf = requestAnimationFrame(tick);
  const rect = thread.getBoundingClientRect();
  return {
    finish() {
      stopped = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      thread.removeEventListener("wheel", onWheel);
      return {
        timeOrigin: performance.timeOrigin,
        frames,
        input,
        samples,
        droppedFrames: dropped,
        droppedMutations: 0,
        mutations: [],
        scrollWrites: [],
        sampling: { totalMs, maxMs },
        paintProbe: {
          version: 1,
          bits,
          stripWidth,
          quantum,
          left: rect.left + thread.clientLeft,
          top: rect.top,
          bottom: rect.bottom,
          width: innerWidth,
          height: innerHeight,
          marker: { cellWidth: 6, height: 12, bits: 16, referenceCells: [0, 1, 19] },
          note: "Snapshot ID is painted after a synchronous DOM/model sample. CSS local background independently encodes compositor scroll; samples are not timing proof.",
        },
      };
    },
    async calibrate(offset: number) {
      thread.scrollTop = offset;
      let stable = 0;
      let previous = "";
      for (let index = 0; index < 180 && stable < 30; index++) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        const current = `${thread.scrollTop}:${thread.scrollHeight}`;
        stable = current === previous ? stable + 1 : 0;
        previous = current;
      }
      return {
        scrollTop: thread.scrollTop,
        scrollHeight: thread.scrollHeight,
        stable: stable >= 30,
      };
    },
    dispose() {
      marker.remove();
      if (previousHook) {
        Object.defineProperty(window, "openclawRenderLifecycleTestHook", previousHook);
      } else {
        Reflect.deleteProperty(window, "openclawRenderLifecycleTestHook");
      }
      restoreBackground();
      renderer = undefined;
    },
  };
}
