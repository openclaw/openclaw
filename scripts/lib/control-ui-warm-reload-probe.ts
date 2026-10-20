/** Browser-only diagnostic, serialized after the mock socket and wire-delay probe. */
export function warmReloadProbe() {
  const milestones: Record<string, number> = {};
  const mutations: Array<{ at: number; count: number; region: string }> = [];
  const shifts: Array<{ at: number; value: number }> = [];
  const states: Array<{ at: number; state: string }> = [];
  const reads: Array<{ at: number; store: string; hit: boolean }> = [];
  const transactions: Array<{
    at: number;
    label: string;
    rows: number;
    sidebarRows: number;
    boardFrames: number;
  }> = [];
  const rows = new Set<Element>();
  type ElementPaint = PerformanceEntry & {
    identifier: string;
    renderTime: number;
    intersectionRect: DOMRectReadOnly;
    element: Element | null;
  };
  const transcriptPaints: Array<{ renderTime: number; element: string; rowKey: string | null }> =
    [];
  const largestPaints: Array<{
    renderTime: number;
    loadTime: number;
    size: number;
    element: string | null;
    transcript: boolean;
  }> = [];
  let removedRows = 0;
  let stopped = false;
  let cachedRows: Element[] = [];
  let retainedAtCatchup: number | null = null;
  const mark = (name: string) => {
    milestones[name] ??= performance.now();
  };
  const observe = (type: string, callback: (entries: PerformanceEntry[]) => void) => {
    new PerformanceObserver((list) => callback(list.getEntries())).observe({
      type,
      buffered: true,
    });
  };
  observe("paint", (entries) => {
    for (const entry of entries) {
      milestones[entry.name] = entry.startTime;
    }
  });
  const elementLabel = (element: Element) =>
    `${element.localName}${element.classList.length ? `.${[...element.classList].join(".")}` : ""}`;
  observe("element", (entries) => {
    for (const entry of entries) {
      // Element Timing is implemented by Chromium but absent from lib.dom.
      const paint = entry as ElementPaint;
      const row = paint.element?.closest(".chat-virtual-row");
      if (
        paint.identifier !== "openclaw-transcript" ||
        !row ||
        !paint.element ||
        paint.renderTime <= 0 ||
        paint.intersectionRect.width <= 0 ||
        paint.intersectionRect.height <= 0
      ) {
        continue;
      }
      milestones.firstTranscriptPaint ??= paint.renderTime;
      transcriptPaints.push({
        renderTime: paint.renderTime,
        element: elementLabel(paint.element),
        rowKey: row.getAttribute("data-virtual-row-key"),
      });
    }
  });
  observe("largest-contentful-paint", (entries) => {
    for (const entry of entries) {
      const paint = entry as LargestContentfulPaint;
      largestPaints.push({
        renderTime: paint.renderTime,
        loadTime: paint.loadTime,
        size: paint.size,
        element: paint.element ? elementLabel(paint.element) : null,
        transcript: Boolean(paint.element?.closest(".chat-virtual-row")),
      });
    }
  });
  observe("layout-shift", (entries) => {
    for (const entry of entries) {
      if (!Reflect.get(entry, "hadRecentInput")) {
        shifts.push({ at: entry.startTime, value: Reflect.get(entry, "value") });
      }
    }
  });
  // Correlate completion tasks with their actual cache owner in diagnostic traces.
  const databasePrototype: {
    transaction: (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) => ReturnType<IDBDatabase["transaction"]>;
  } = IDBDatabase.prototype;
  const transaction = databasePrototype.transaction;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args) {
    const result = transaction.apply(this, args);
    const label = `${this.name}:${[...result.objectStoreNames].join(",")}:${result.mode}`;
    result.addEventListener("complete", () => {
      performance.mark(`warm-idb:${label}`);
      transactions.push({
        at: performance.now(),
        label,
        rows: document.querySelectorAll(".chat-virtual-row").length,
        sidebarRows: document.querySelectorAll(".sidebar-recent-session").length,
        boardFrames: document.querySelectorAll(".board-widget__frame").length,
      });
    });
    return result;
  };
  // Preserve the native method so each probe call can pass its actual store as this.
  const storePrototype: {
    get: (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange,
    ) => ReturnType<IDBObjectStore["get"]>;
  } = IDBObjectStore.prototype;
  const get = storePrototype.get;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args) {
    const request = get.apply(this, args);
    const store = this.name;
    request.addEventListener("success", () => {
      reads.push({ at: performance.now(), store, hit: request.result !== undefined });
      if (store === "snapshots" && request.result !== undefined) {
        mark("cacheRead");
      }
    });
    return request;
  };
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      const socket: WebSocket = Reflect.construct(target, args);
      const pending = new Map<string, string>();
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.type === "req") {
            pending.set(frame.id, frame.method);
          }
        }
        send(data);
      };
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data);
        const method = pending.get(frame.id);
        if (method) {
          pending.delete(frame.id);
          if (method === "connect") {
            mark("hello");
          }
          if (method === "chat.startup") {
            mark("catchupResponse");
          }
        }
      });
      return socket;
    },
  });
  const observer = new MutationObserver((records) => {
    const regions = new Map<string, number>();
    const textRoots = new Set<Element>();
    for (const record of records) {
      const element =
        record.target instanceof Element ? record.target : record.target.parentElement;
      const region = element
        ?.closest(".chat-thread, openclaw-chat-pane, openclaw-app-sidebar")
        ?.classList.contains("chat-thread")
        ? "transcript"
        : (element?.closest("openclaw-chat-pane, openclaw-app-sidebar")?.localName ?? "shell");
      regions.set(region, (regions.get(region) ?? 0) + 1);
      const textRoot = element?.closest(".chat-text");
      if (textRoot) {
        textRoots.add(textRoot);
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (node.matches(".chat-text")) {
          textRoots.add(node);
        }
        for (const root of node.querySelectorAll(".chat-text")) {
          textRoots.add(root);
        }
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (rows.has(node)) {
          removedRows++;
        }
        for (const row of node.querySelectorAll(".chat-virtual-row")) {
          if (rows.has(row)) {
            removedRows++;
          }
        }
      }
    }
    // Tag direct text owners before paint. A row/container attribute does not
    // cover descendant block text, and a DOM/rAF timestamp is not presentation.
    for (const root of textRoots) {
      if (!root.closest(".chat-virtual-row")) {
        continue;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        const parent = text.parentElement;
        if (text.textContent?.trim() && parent && !parent.hasAttribute("elementtiming")) {
          parent.setAttribute("elementtiming", "openclaw-transcript");
        }
      }
    }
    for (const [region, count] of regions) {
      mutations.push({ at: performance.now(), region, count });
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const sample = () => {
    if (stopped) {
      return;
    }
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const thread = pane?.querySelector(".chat-thread");
    const inner = thread?.querySelector(".chat-thread-inner");
    const currentRows = [...(thread?.querySelectorAll(".chat-virtual-row") ?? [])];
    for (const row of currentRows) {
      rows.add(row);
    }
    const visible = Boolean(
      currentRows.length && inner && getComputedStyle(inner).visibility !== "hidden",
    );
    if (visible) {
      mark("firstTranscript");
      if (!milestones.catchupResponse && milestones.cacheRead) {
        mark("firstCachedTranscript");
        if (!cachedRows.length) {
          cachedRows = currentRows;
        }
      }
    }
    const caughtUp = Boolean(pane && Reflect.get(pane, "transcriptReady"));
    if (caughtUp && !milestones.catchupApplied) {
      mark("catchupApplied");
      retainedAtCatchup = cachedRows.filter((row) => row.isConnected).length;
    }
    const input = pane?.querySelector<HTMLTextAreaElement>("textarea");
    if (input && !input.disabled && !input.readOnly) {
      mark("inputReady");
    }
    const state = JSON.stringify({
      shell: Boolean(document.querySelector(".shell")),
      sidebar: Boolean(document.querySelector("aside.sidebar")),
      header: pane?.querySelector(".chat-pane__session-title-text")?.textContent ?? null,
      rows: visible,
      input: Boolean(input && !input.disabled),
      board: Boolean(document.querySelector(".board-widget__frame")),
    });
    if (states.at(-1)?.state !== state) {
      states.push({ at: performance.now(), state });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  Reflect.set(window, "__warmReload", {
    read() {
      stopped = true;
      observer.disconnect();
      const perf = Reflect.get(window, "__perf");
      return {
        milestones,
        transcriptPaints,
        largestPaints,
        reads,
        transactions,
        shifts,
        cls: shifts.reduce((sum, shift) => sum + shift.value, 0),
        lastLayoutShift: shifts.at(-1)?.at ?? null,
        lastMutationBurst: mutations.findLast((batch) => batch.count >= 10)?.at ?? null,
        mutations,
        states,
        rows: {
          mounted: rows.size,
          removed: removedRows,
          cached: cachedRows.length,
          retainedAtCatchup,
        },
        loaf: perf?.loaf ?? [],
        rpcCensus: Reflect.get(window, "__wsLog") ?? [],
      };
    },
  });
}
