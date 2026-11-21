/** Retained-row geometry shared by warm-reload proof and browser regressions. */
export function installWarmReloadTranscriptProbe(mode: "reader" | "end" = "end") {
  const frames: Array<{
    atMs: number;
    scrollTop: number;
    viewportTop: number;
    viewportHeight: number;
    scrollHeight: number;
    innerTop: number;
    innerHeight: number;
    innerStyleHeight: string;
    columnTop: number | null;
    columnMarginTop: string | null;
    distanceFromEnd: number;
    rows: Array<{
      key: string;
      index: string | undefined;
      y: number;
      height: number;
      characters: number;
      size: number;
      blockTop: number | null;
      blockStyleTop: string | null;
    }>;
  }> = [];
  let anchor: string | undefined;
  let previous = "";
  let frame = 0;
  let readerFrame = 0;
  let readerReady = mode === "end";
  const sampleFrame = () => {
    const thread = document.querySelector<HTMLElement>(
      ".chat-pane-cache__pane--active .chat-thread",
    );
    const inner = thread?.querySelector<HTMLElement>(".chat-thread-inner--virtual");
    if (thread && inner?.checkVisibility({ checkOpacity: true, visibilityProperty: true })) {
      if (!readerReady) {
        if (!readerFrame) {
          // Deliver reader input after the cached frame and its mount listeners commit.
          readerFrame = requestAnimationFrame(() => {
            readerFrame = requestAnimationFrame(() => {
              thread.addEventListener(
                "scrollend",
                () => {
                  readerReady = true;
                },
                { once: true },
              );
              thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
              thread.scrollTop -= 240;
            });
          });
        }
        frame = requestAnimationFrame(sampleFrame);
        return;
      }
      const viewport = thread.getBoundingClientRect();
      const innerRect = inner.getBoundingClientRect();
      const column = inner.querySelector<HTMLElement>(".chat-virtual-sizer");
      const rows = [
        ...inner.querySelectorAll<HTMLElement>(".chat-virtual-row:not([data-prepared-row])"),
      ].map((row) => {
        const rect = row.getBoundingClientRect();
        const block = row.closest<HTMLElement>(".chat-virtual-block");
        return {
          key: row.dataset.virtualRowKey ?? "",
          index: row.dataset.index,
          y: rect.y,
          height: rect.height,
          characters: row.textContent?.length ?? 0,
          size: Number.parseFloat(row.dataset.rowSize ?? ""),
          blockTop: block?.getBoundingClientRect().top ?? null,
          blockStyleTop: block?.style.top ?? null,
        };
      });
      // Establish the reader after the gesture's admitted rows are measured, before live history.
      if (
        mode === "reader" &&
        !anchor &&
        rows.some((row) => Math.abs(row.height - row.size) > 0.5)
      ) {
        frame = requestAnimationFrame(sampleFrame);
        return;
      }
      anchor ??= rows.find(
        (row) => row.y + row.height > viewport.top && row.y < viewport.bottom,
      )?.key;
      const state = {
        scrollTop: thread.scrollTop,
        viewportTop: viewport.top,
        viewportHeight: thread.clientHeight,
        scrollHeight: thread.scrollHeight,
        innerTop: innerRect.top,
        innerHeight: innerRect.height,
        innerStyleHeight: inner.style.height,
        columnTop: column?.getBoundingClientRect().top ?? null,
        columnMarginTop: column?.style.marginTop ?? null,
        distanceFromEnd: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
        rows,
      };
      const signature = JSON.stringify(state);
      if (signature !== previous) {
        frames.push({ atMs: performance.now(), ...state });
        previous = signature;
      }
    }
    frame = requestAnimationFrame(sampleFrame);
  };
  frame = requestAnimationFrame(sampleFrame);
  const probe = {
    get ready() {
      return Boolean(anchor);
    },
    read() {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(readerFrame);
      if (!anchor || !frames.length) {
        throw new Error("No visible cached transcript anchor was sampled");
      }
      const rowsSignature = (sample: (typeof frames)[number]) =>
        JSON.stringify(sample.rows.map(({ key, height, characters }) => [key, height, characters]));
      const finalRowsDomMs =
        frames.findLast(
          (sample, index) =>
            index === 0 || rowsSignature(sample) !== rowsSignature(frames[index - 1]!),
        )?.atMs ?? null;
      const positions = frames.map((sample) => sample.rows.find((row) => row.key === anchor)?.y);
      const visible = positions.filter((value): value is number => value !== undefined);
      const movement = visible
        .slice(1)
        .reduce((sum, y, index) => sum + Math.abs(y - visible[index]!), 0);
      const displacement = visible.length ? Math.abs(visible.at(-1)! - visible[0]!) : 0;
      return {
        anchor,
        finalRowsDomMs,
        frames,
        missingAnchorFrames: positions.length - visible.length,
        movementPx: movement,
        excessMovementPx: movement - displacement,
      };
    },
  };
  Reflect.set(window, "__activeTranscriptReload", probe);
  return probe;
}
