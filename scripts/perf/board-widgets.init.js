// Synthetic warm-reload panel metrics; never records widget or message contents.
(() => {
  if (window !== window.top) {
    return;
  }
  let previousAt = 0;
  let skeletonCount = 0;
  let skeletonMs = 0;
  let allWidgetsVisibleMs = null;
  let cachedBoardLayoutMs = null;
  function sample() {
    const proof = Reflect.get(window, "__warmReloadProof");
    if (proof?.stopped) {
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
        inert: frame.inert,
      })),
    }));
    const now = performance.now();
    if (document.querySelector("openclaw-board-view .board-widget")) {
      cachedBoardLayoutMs ??= now;
    }
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
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();
