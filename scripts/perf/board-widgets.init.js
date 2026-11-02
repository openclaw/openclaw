// Synthetic warm-reload attribution only; never records widget or message contents.
(() => {
  if (window !== window.top) return;
  const events = [];
  const frames = new WeakMap();
  let nextFrame = 0;
  let previous = "";
  let previousAt = 0;
  let skeletonCount = 0;
  let skeletonMs = 0;
  let allWidgetsVisibleMs = null;
  let cachedBoardLayoutMs = null;
  const frameId = (frame) => {
    if (!frames.has(frame)) frames.set(frame, ++nextFrame);
    return frames.get(frame);
  };
  const record = (kind, detail) => events.push({ atMs: performance.now(), kind, ...detail });
  const originalFetch = window.fetch;
  window.fetch = async function (input, options) {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (!url.pathname.startsWith("/__openclaw__/board/")) {
      return originalFetch.call(this, input, options);
    }
    record("document-fetch", { path: url.pathname, cache: options?.cache ?? "default" });
    try {
      const response = await originalFetch.call(this, input, options);
      record("document-response", { path: url.pathname, status: response.status });
      return response;
    } catch (error) {
      record("document-error", { path: url.pathname, name: error.name });
      throw error;
    }
  };
  window.addEventListener("message", (event) => {
    const frame = [...document.querySelectorAll("iframe")].find(
      (candidate) => candidate.contentWindow === event.source,
    );
    if (!frame?.closest("openclaw-board-view")) return;
    const method = event.data?.method ?? event.data?.type;
    if (typeof method === "string" && /sandbox|widget/u.test(method)) {
      record("message", { frame: frameId(frame), method });
    }
  });
  const observer = new MutationObserver(() => {
    for (const frame of document.querySelectorAll("openclaw-board-view iframe")) {
      if (frames.has(frame)) continue;
      record("iframe-created", {
        frame: frameId(frame),
        path: new URL(frame.src, location.href).pathname,
      });
      frame.addEventListener("load", () => record("iframe-load", { frame: frameId(frame) }));
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  function sample() {
    const proof = window.__warmReloadProof;
    if (proof) proof.boardWidgetTimeline = events;
    if (proof?.stopped) {
      observer.disconnect();
      return;
    }
    const skeletons = [...document.querySelectorAll("openclaw-panel-loading-skeleton")].map(
      (element) => {
        const box = element.getBoundingClientRect();
        const parents = [];
        for (
          let parent = element.parentElement;
          parent && parents.length < 5;
          parent = parent.parentElement
        ) {
          parents.push(`${parent.localName}.${parent.className}`);
        }
        return {
          variant: element.dataset.panelSkeleton,
          shimmers: [...element.querySelectorAll(".skeleton")].filter((shimmer) => {
            const rect = shimmer.getBoundingClientRect();
            return (
              shimmer.checkVisibility({ checkOpacity: true, visibilityProperty: true }) &&
              rect.bottom > 0 &&
              rect.top < innerHeight &&
              rect.right > 0 &&
              rect.left < innerWidth
            );
          }).length,
          visible:
            element.checkVisibility({ checkOpacity: true, visibilityProperty: true }) &&
            box.bottom > 0 &&
            box.top < innerHeight &&
            box.width > 0,
          parents,
        };
      },
    );
    const boards = [...document.querySelectorAll("openclaw-board-view")].map((board) => ({
      loading: board.hasAttribute("data-initial-loading"),
      frames: [...board.querySelectorAll("iframe")].map((frame) => ({
        frame: frameId(frame),
        inert: frame.inert,
        opacity: getComputedStyle(frame).opacity,
        visible: frame.checkVisibility({ checkOpacity: true, visibilityProperty: true }),
      })),
    }));
    const now = performance.now();
    if (document.querySelector("openclaw-board-view .board-widget")) cachedBoardLayoutMs ??= now;
    skeletonMs += (now - previousAt) * skeletonCount;
    previousAt = now;
    skeletonCount = skeletons.reduce(
      (count, skeleton) =>
        count +
        (skeleton.visible &&
        (skeleton.variant === "board" ||
          skeleton.parents.some((parent) => parent.startsWith("div.board-widget__frame-pane")))
          ? skeleton.shimmers
          : 0),
      0,
    );
    if (
      boards.length &&
      boards.every(
        (board) =>
          !board.loading && board.frames.length && board.frames.every((frame) => !frame.inert),
      )
    ) {
      allWidgetsVisibleMs ??= now;
    }
    if (proof) {
      proof.boardWidgetSkeletonMs = skeletonMs;
      proof.allBoardWidgetsVisibleMs = allWidgetsVisibleMs;
      proof.cachedBoardLayoutMs = cachedBoardLayoutMs;
    }
    const state = JSON.stringify({ skeletons, boards });
    if (state !== previous) {
      record("presentation", { skeletons, boards });
      previous = state;
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();
