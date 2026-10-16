/** Browser-only diagnostic, serialized after the mock socket and wire-delay probe. */
export function warmReloadProbe() {
  const milestones: Record<string, number> = {};
  const mutations: Array<{ at: number; count: number; region: string }> = [];
  const shifts: Array<{ at: number; value: number }> = [];
  const states: Array<{ at: number; state: string }> = [];
  const reads: Array<{ at: number; store: string; hit: boolean }> = [];
  const rows = new Set<Element>();
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
  observe("layout-shift", (entries) => {
    for (const entry of entries) {
      if (!Reflect.get(entry, "hadRecentInput")) {
        shifts.push({ at: entry.startTime, value: Reflect.get(entry, "value") });
      }
    }
  });
  // Preserve the native method so each probe call can pass its actual store as this.
  // oxlint-disable-next-line typescript/unbound-method
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (...args) {
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
    for (const record of records) {
      const element =
        record.target instanceof Element ? record.target : record.target.parentElement;
      const region = element
        ?.closest(".chat-thread, openclaw-chat-pane, openclaw-app-sidebar")
        ?.classList.contains("chat-thread")
        ? "transcript"
        : (element?.closest("openclaw-chat-pane, openclaw-app-sidebar")?.localName ?? "shell");
      regions.set(region, (regions.get(region) ?? 0) + 1);
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
        reads,
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
