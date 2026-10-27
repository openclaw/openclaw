/** Browser-only diagnostic, serialized after the mock socket and wire-delay probe. */
export function warmReloadProbe(
  input: { rowFacts?: boolean; avatars?: boolean; lateRowFacts?: boolean } = {},
  samplePaneChrome?: (at: number) => void,
) {
  const milestones: Record<string, number> = {};
  const mutations: Array<{ at: number; count: number; region: string }> = [];
  const shifts: Array<{ at: number; value: number }> = [];
  const states: Array<{ at: number; state: string }> = [];
  const longTasks: Array<{ at: number; duration: number }> = [];
  const reads: Array<{ at: number; store: string; hit: boolean; cursor?: boolean }> = [];
  const historyRequests: Array<{
    method: string;
    sentAt: number;
    cursor: boolean;
    receivedAt?: number;
    responseBytes?: number;
    kind?: string;
    messages?: number;
  }> = [];
  const transactions: Array<{
    at: number;
    label: string;
    rows: number;
    sidebarRows: number;
    boardFrames: number;
  }> = [];
  const rows = new Set<Element>();
  const avatars = new WeakSet<Element>();
  const avatarTransitions: Array<{ at: number; region: string; attribute: string }> = [];
  const sidebarFrames: Array<{
    at: number;
    cached: boolean;
    rowIds: string[];
    orderHash: number;
    headers: string[];
    avatars: string[];
    retained: number;
  }> = [];
  let cachedSidebarRows: Element[] = [];
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
  const factSelectors: Record<string, string> = {
    reactions: ".chat-message-reactions",
    notices: ".chat-run-failure",
    activity: ".chat-activity-group",
    meta: ".msg-meta",
    ...(input.lateRowFacts
      ? {
          links: ".markdown-session-link, .markdown-github-item",
          images: ".chat-image-frame",
          canonicalNotices: ".chat-notice",
          avatars: ".chat-avatar, .chat-author-avatar",
        }
      : {}),
  };
  const lateFrames: Array<{
    at: number;
    cached: boolean;
    height: number | undefined;
    links: string[];
    images: string[];
    notices: string[];
    avatars: string[];
  }> = [];
  const imageFact = (image: HTMLImageElement) => [
    image.getAttribute("src")?.startsWith("blob:")
      ? image.getAttribute("src")
      : image.getAttribute("src")?.split("?", 1)[0],
    image.complete && image.naturalWidth > 0,
    image.naturalWidth,
    image.naturalHeight,
  ];
  const factFrames: Array<{
    at: number;
    changes: Array<{ rowKey: string | null; parts: string[]; heightDelta: number }>;
  }> = [];
  const threadFrames: Array<{ at: number; height: number; rowKeys: Array<string | null> }> = [];
  const rowWindows: Array<{ at: number; rowKeys: Array<string | null> }> = [];
  const firstRowFacts: Array<{
    rowKey: string | null;
    cached: boolean;
    counts: Record<string, number>;
  }> = [];
  const observed = new WeakSet<Element>();
  const sizes = new WeakMap<Element, number>();
  const rowFacts = new WeakMap<
    Element,
    {
      parts: Record<string, string>;
      heights: Record<string, Array<number | undefined>>;
      height?: number;
      cached: boolean;
    }
  >();
  let observedThread: Element | undefined;
  const resize = input.rowFacts
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
          sizes.set(entry.target, height);
          if (entry.target === observedThread && lateFrames.length) {
            lateFrames.at(-1)!.height = height;
          }
        }
      })
    : undefined;
  const observeSize = (element: Element) => {
    if (!observed.has(element)) {
      observed.add(element);
      resize?.observe(element);
    }
  };
  let retainedAtCatchup: number | null = null;
  const duplicateRowKeys = new Set<string>();
  type TranscriptAnchor = {
    at: number;
    rowKey: string;
    offset: number;
    scrollTop: number;
  };
  let cachedAnchor: TranscriptAnchor | null = null;
  let liveAnchor: TranscriptAnchor | null = null;
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
  observe("longtask", (entries) => {
    for (const entry of entries) {
      longTasks.push({ at: entry.startTime, duration: entry.duration });
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
      reads.push({
        at: performance.now(),
        store,
        hit: request.result !== undefined,
        ...(store === "snapshots"
          ? { cursor: Boolean(request.result?.snapshot?.deltaCursor) }
          : {}),
      });
      if (store === "snapshots" && request.result !== undefined) {
        mark("cacheRead");
      }
    });
    return request;
  };
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      mark("socketCreated");
      const socket: WebSocket = Reflect.construct(target, args);
      socket.addEventListener("open", () => mark("socketOpen"), { once: true });
      const pending = new Map<
        string,
        { method: string; history?: (typeof historyRequests)[number] }
      >();
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.type === "req") {
            const params = frame.params?.initialHistory ?? frame.params;
            const history =
              frame.method === "chat.startup" ||
              frame.method === "chat.history" ||
              (frame.method === "sessions.messages.subscribe" && frame.params?.initialHistory)
                ? {
                    method: frame.method,
                    sentAt: performance.now(),
                    cursor: Boolean(params?.cursor),
                  }
                : undefined;
            if (history) {
              historyRequests.push(history);
            }
            pending.set(frame.id, { method: frame.method, history });
            if (frame.method === "connect") {
              mark("connectSent");
            } else if (milestones.hello !== undefined) {
              mark("firstPostHelloRpc");
            }
          }
        }
        send(data);
      };
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "event" && frame.event === "connect.challenge") {
          mark("challenge");
        }
        const request = pending.get(frame.id);
        if (request) {
          pending.delete(frame.id);
          const { method, history } = request;
          if (history) {
            const result =
              method === "sessions.messages.subscribe"
                ? frame.payload?.initialHistory?.payload
                : frame.payload;
            history.receivedAt = performance.now();
            history.responseBytes = new TextEncoder().encode(event.data).byteLength;
            history.kind = result?.kind ?? (result?.messages ? "window" : "error");
            history.messages = result?.messages?.length;
          }
          if (method === "connect") {
            mark("hello");
          }
          if (
            method === "chat.startup" ||
            (method === "sessions.messages.subscribe" && frame.payload?.initialHistory)
          ) {
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
    const textSelector = input.lateRowFacts ? ".chat-text, .chat-notice" : ".chat-text";
    for (const record of records) {
      const element =
        record.target instanceof Element ? record.target : record.target.parentElement;
      const region = element
        ?.closest(".chat-thread, openclaw-chat-pane, openclaw-app-sidebar")
        ?.classList.contains("chat-thread")
        ? "transcript"
        : (element?.closest("openclaw-chat-pane, openclaw-app-sidebar")?.localName ?? "shell");
      regions.set(region, (regions.get(region) ?? 0) + 1);
      if (
        input.avatars &&
        element &&
        avatars.has(element) &&
        record.type === "attributes" &&
        record.attributeName &&
        ["class", "src", "data-avatar-state"].includes(record.attributeName) &&
        record.oldValue !== element.getAttribute(record.attributeName)
      ) {
        avatarTransitions.push({ at: performance.now(), region, attribute: record.attributeName });
      }
      const textRoot = element?.closest(textSelector);
      if (textRoot) {
        textRoots.add(textRoot);
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (node.matches(textSelector)) {
          textRoots.add(node);
        }
        for (const root of node.querySelectorAll(textSelector)) {
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
    attributeOldValue: input.avatars,
    characterData: true,
  });
  const sample = (frameAt: number) => {
    if (stopped) {
      return;
    }
    const sidebar = document.querySelector("aside.sidebar");
    if (sidebar || sidebarFrames.length) {
      const sidebarRows = [
        ...(sidebar?.querySelectorAll(".sidebar-session-content .sidebar-recent-session") ?? []),
      ];
      const cached = sidebar?.getAttribute("data-snapshot-state") === "cached";
      if (cached && !cachedSidebarRows.length) {
        cachedSidebarRows = sidebarRows;
      }
      const rowIds = sidebarRows.map((row) => row.getAttribute("data-session-key") ?? "");
      let orderHash = 2166136261;
      for (const character of rowIds.join("\0")) {
        orderHash = Math.imul(orderHash ^ character.charCodeAt(0), 16777619) >>> 0;
      }
      sidebarFrames.push({
        at: performance.now(),
        cached,
        rowIds,
        orderHash,
        headers: [...(sidebar?.querySelectorAll("[data-session-section]") ?? [])].map(
          (section) =>
            `${section.getAttribute("data-session-section")}:${section.querySelector(".sidebar-session-group-toggle")?.getAttribute("aria-label") ?? ""}`,
        ),
        avatars: sidebarRows.map((row) =>
          [...row.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "").join("|"),
        ),
        retained: cachedSidebarRows.filter((row) => row.isConnected).length,
      });
    }
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const thread = pane?.querySelector(".chat-thread");
    const inner = thread?.querySelector(".chat-thread-inner");
    const currentRows = [...(thread?.querySelectorAll(".chat-virtual-row") ?? [])];
    if (input.avatars && currentRows.length) {
      for (const element of document.querySelectorAll(
        ".chat-thread :is(.chat-avatar-slot, .chat-author-avatar, .identity-avatar--agent, img), aside.sidebar :is(.viewer-avatar, .identity-avatar--agent, img)",
      )) {
        avatars.add(element);
      }
    }
    const currentKeys = new Set<string>();
    for (const row of currentRows) {
      rows.add(row);
      const key = row.getAttribute("data-virtual-row-key");
      if (key) {
        if (currentKeys.has(key)) {
          duplicateRowKeys.add(key);
        }
        currentKeys.add(key);
      }
    }
    const visible = Boolean(
      currentRows.length && inner && getComputedStyle(inner).visibility !== "hidden",
    );
    if (visible) {
      mark("firstTranscript");
      if (input.lateRowFacts && thread && inner) {
        observedThread = inner;
        observeSize(inner);
        lateFrames.push({
          at: performance.now(),
          cached: Boolean(milestones.cacheRead && !milestones.catchupResponse),
          height: sizes.get(inner),
          links: [...thread.querySelectorAll<HTMLElement>(factSelectors.links!)].map((link) =>
            JSON.stringify([
              link.textContent,
              link.className,
              link.dataset.linkReaderTone,
              link.getAttribute("aria-description"),
            ]),
          ),
          images: [...thread.querySelectorAll<HTMLElement>(factSelectors.images!)].map((frame) =>
            JSON.stringify([
              frame.className,
              frame.getAttribute("style"),
              [...frame.querySelectorAll("img")].map(imageFact),
            ]),
          ),
          notices: [...thread.querySelectorAll<HTMLElement>(factSelectors.canonicalNotices!)].map(
            (notice) =>
              JSON.stringify([
                notice.getAttribute("data-chat-row-key"),
                notice.className,
                notice.textContent,
              ]),
          ),
          avatars: [...thread.querySelectorAll<HTMLElement>(factSelectors.avatars!)].map((avatar) =>
            JSON.stringify([
              avatar.className,
              [...avatar.querySelectorAll("img")].map(imageFact),
              avatar.textContent,
            ]),
          ),
        });
      }
      if (resize && inner) {
        const at = performance.now();
        const rowKeys = currentRows.map((row) => row.getAttribute("data-virtual-row-key"));
        if (JSON.stringify(rowWindows.at(-1)?.rowKeys) !== JSON.stringify(rowKeys)) {
          rowWindows.push({ at, rowKeys });
        }
        observeSize(inner);
        const threadHeight = sizes.get(inner);
        if (threadHeight !== undefined && threadFrames.at(-1)?.height !== threadHeight) {
          threadFrames.push({ at, height: threadHeight, rowKeys });
        }
        const changes: (typeof factFrames)[number]["changes"] = [];
        for (const row of currentRows) {
          observeSize(row);
          const parts: Record<string, string> = {};
          const heights: Record<string, Array<number | undefined>> = {};
          const counts: Record<string, number> = {};
          for (const [part, selector] of Object.entries(factSelectors)) {
            const elements = [...row.querySelectorAll(selector)];
            elements.forEach(observeSize);
            parts[part] = JSON.stringify(
              elements.map((element) => [
                element.textContent,
                element.querySelectorAll("*").length,
                ...(input.lateRowFacts
                  ? [
                      element.className,
                      element.getAttribute("style"),
                      element.getAttribute("aria-description"),
                      [...element.querySelectorAll("img")].map(imageFact),
                    ]
                  : []),
              ]),
            );
            heights[part] = elements.map((element) => sizes.get(element));
            counts[part] = elements.length;
          }
          const previous = rowFacts.get(row);
          const height = sizes.get(row);
          const cached =
            previous?.cached ?? Boolean(milestones.cacheRead && !milestones.catchupResponse);
          if (previous?.cached) {
            const changed = Object.keys(parts).filter(
              (part) =>
                previous.parts[part] !== parts[part] ||
                heights[part]!.some((partHeight, index) => {
                  const before = previous.heights[part]?.[index];
                  return (
                    partHeight !== undefined &&
                    before !== undefined &&
                    Math.abs(partHeight - before) > 0.5
                  );
                }),
            );
            const heightDelta =
              height !== undefined && previous.height !== undefined ? height - previous.height : 0;
            if (changed.length || Math.abs(heightDelta) > 0.5) {
              changes.push({
                rowKey: row.getAttribute("data-virtual-row-key"),
                parts: changed,
                heightDelta,
              });
            }
          } else if (!previous) {
            // A new row's complete first frame is the baseline, never an addition.
            firstRowFacts.push({
              rowKey: row.getAttribute("data-virtual-row-key"),
              cached,
              counts,
            });
          }
          rowFacts.set(row, { parts, heights, height, cached });
        }
        if (changes.length) {
          factFrames.push({ at, changes });
        }
      }
      if (!milestones.catchupResponse && milestones.cacheRead) {
        mark("firstCachedTranscript");
        if (!cachedRows.length) {
          cachedRows = currentRows;
        }
        if (thread) {
          const bounds = thread.getBoundingClientRect();
          for (const row of currentRows) {
            const rowKey = row.getAttribute("data-virtual-row-key");
            const rect = row.getBoundingClientRect();
            if (rowKey && rect.bottom > bounds.top && rect.top < bounds.bottom) {
              // Keep the last cached frame, after initial virtualizer positioning.
              cachedAnchor = {
                at: performance.now(),
                rowKey,
                offset: rect.top - bounds.top,
                scrollTop: thread.scrollTop,
              };
              break;
            }
          }
        }
      }
    }
    const caughtUp = Boolean(pane && Reflect.get(pane, "transcriptReady"));
    if (caughtUp && !milestones.catchupApplied) {
      mark("catchupApplied");
      retainedAtCatchup = cachedRows.filter((row) => row.isConnected).length;
      const row = currentRows.find(
        (candidate) => candidate.getAttribute("data-virtual-row-key") === cachedAnchor?.rowKey,
      );
      if (cachedAnchor && thread && row) {
        liveAnchor = {
          at: performance.now(),
          rowKey: cachedAnchor.rowKey,
          offset: row.getBoundingClientRect().top - thread.getBoundingClientRect().top,
          scrollTop: thread.scrollTop,
        };
      }
    }
    const composer = pane?.querySelector<HTMLTextAreaElement>("textarea");
    if (composer && !composer.disabled && !composer.readOnly) {
      mark("inputReady");
    }
    const state = JSON.stringify({
      shell: Boolean(document.querySelector(".shell")),
      bootSkeleton: Boolean(document.querySelector("#openclaw-boot-shell")),
      viewSkeleton: Boolean(document.querySelector(".lazy-view-state--loading")),
      pane: Boolean(pane),
      sidebar: Boolean(document.querySelector("aside.sidebar")),
      header: pane?.querySelector(".chat-pane__session-title-text")?.textContent ?? null,
      rows: visible,
      input: Boolean(composer && !composer.disabled),
      board: Boolean(document.querySelector(".board-widget__frame")),
    });
    if (states.at(-1)?.state !== state) {
      states.push({ at: performance.now(), state });
    }
    samplePaneChrome?.(frameAt);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  Reflect.set(window, "__warmReload", {
    read() {
      stopped = true;
      observer.disconnect();
      resize?.disconnect();
      const perf = Reflect.get(window, "__perf");
      const coverage = input.rowFacts
        ? Object.fromEntries(
            Object.entries(factSelectors).map(([part, selector]) => [
              part,
              document.querySelectorAll(`.chat-pane-cache__pane--active .chat-thread ${selector}`)
                .length,
            ]),
          )
        : {};
      if (
        input.rowFacts &&
        (!firstRowFacts.some((row) => row.cached) ||
          Object.values(coverage).some((count) => count === 0))
      ) {
        throw new Error(
          `Unqualified row-facts sample: cached rows or fact coverage missing (${JSON.stringify(coverage)})`,
        );
      }
      const pane = document.querySelector(".chat-pane-cache__pane--active");
      const thread = pane?.querySelector(".chat-thread");
      const bounds = thread?.getBoundingClientRect();
      const textRoots = [
        ...(thread?.querySelectorAll(".chat-virtual-row .chat-text") ?? []),
      ].filter((element) => element.textContent?.trim());
      // Capture-only eligibility explains missing Element Timing without turning
      // a DOM observation or compositor-only reveal into a measured text paint.
      const paintable = textRoots.some((element) => {
        if (!bounds || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return (
          Math.min(rect.right, bounds.right, innerWidth) > Math.max(rect.left, bounds.left, 0) &&
          Math.min(rect.bottom, bounds.bottom, innerHeight) > Math.max(rect.top, bounds.top, 0)
        );
      });
      const firstPaint = milestones.firstTranscriptPaint ?? milestones.firstTranscript;
      // The rAF sample immediately before presentation owns that painted frame.
      const firstPaintedFrame =
        firstPaint === undefined ? -1 : lateFrames.findLastIndex((frame) => frame.at <= firstPaint);
      const paintedLateFrames =
        firstPaint === undefined ? [] : lateFrames.slice(Math.max(0, firstPaintedFrame));
      const firstLateFrame = paintedLateFrames[0];
      const lateChanges = paintedLateFrames.slice(1).flatMap((frame, index) => {
        const previous = paintedLateFrames[index]!;
        const parts = (["links", "images", "notices", "avatars"] as const).filter(
          (part) => JSON.stringify(frame[part]) !== JSON.stringify(previous[part]),
        );
        const heightDelta =
          frame.height !== undefined && previous.height !== undefined
            ? frame.height - previous.height
            : 0;
        return parts.length || Math.abs(heightDelta) > 0.5
          ? [{ at: frame.at, parts, heightDelta }]
          : [];
      });
      if (
        input.lateRowFacts &&
        (firstPaintedFrame < 0 ||
          !firstLateFrame?.cached ||
          milestones.firstTranscriptPaint === undefined)
      ) {
        throw new Error(
          "Unqualified late-row-facts sample: no measured cached first transcript paint",
        );
      }
      return {
        milestones,
        transcriptPresentation: {
          at: performance.now(),
          status:
            milestones.firstTranscriptPaint !== undefined
              ? "measured"
              : paintable
                ? "visible-without-element-timing"
                : textRoots.length
                  ? "hidden-or-clipped"
                  : pane
                    ? "empty"
                    : "absent",
          paintable,
          textRoots: textRoots.length,
          taggedTextOwners:
            pane?.querySelectorAll('[elementtiming="openclaw-transcript"]').length ?? 0,
        },
        measures: performance.getEntriesByType("measure").map((entry) => entry.toJSON()),
        transcriptPaints,
        largestPaints,
        reads,
        historyRequests,
        transactions,
        shifts,
        cls: shifts.reduce((sum, shift) => sum + shift.value, 0),
        lastLayoutShift: shifts.at(-1)?.at ?? null,
        lastMutationBurst: mutations.findLast((batch) => batch.count >= 10)?.at ?? null,
        mutations,
        rowFacts: input.rowFacts
          ? {
              firstRowFacts,
              frames: factFrames,
              threadFrames,
              rowWindows,
              coverage,
            }
          : undefined,
        lateRowFacts: input.lateRowFacts
          ? {
              boundary: firstPaint,
              measuredPaint: milestones.firstTranscriptPaint !== undefined,
              firstFrame: firstLateFrame,
              frames: paintedLateFrames,
              changes: lateChanges,
              visualChanges: lateChanges.filter((change) => change.parts.length).length,
              heightDelta:
                firstLateFrame?.height !== undefined &&
                paintedLateFrames.at(-1)?.height !== undefined
                  ? paintedLateFrames.at(-1)!.height! - firstLateFrame.height
                  : null,
              maximumHeightChange:
                firstLateFrame?.height === undefined
                  ? null
                  : Math.max(
                      0,
                      ...paintedLateFrames.map((frame) =>
                        Math.abs((frame.height ?? firstLateFrame.height!) - firstLateFrame.height!),
                      ),
                    ),
            }
          : undefined,
        states,
        longTasks,
        sidebarFrames,
        avatarTransitions: input.avatars ? avatarTransitions : undefined,
        rows: {
          mounted: rows.size,
          removed: removedRows,
          cached: cachedRows.length,
          retainedAtCatchup,
          duplicateKeys: [...duplicateRowKeys],
        },
        handoff: {
          cachedAnchor,
          liveAnchor,
          anchorShift: cachedAnchor && liveAnchor ? liveAnchor.offset - cachedAnchor.offset : null,
        },
        externalRig: {
          loaf: perf !== undefined,
          rpcCensus: Reflect.has(window, "__wsLog"),
        },
        loaf: perf?.loaf ?? [],
        rpcCensus: Reflect.get(window, "__wsLog") ?? [],
      };
    },
  });
}
