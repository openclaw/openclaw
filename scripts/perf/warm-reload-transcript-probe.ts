/** Synthetic warm-reload attribution, shared by the benchmark and browser regression. */
export function installWarmReloadTranscriptProbe(mode: "reader" | "end" = "end") {
  const frames: Array<{
    atMs: number;
    scrollTop: number;
    distanceFromEnd: number;
    scrollHeight: number;
    clientHeight: number;
    rangeHeight: string;
    columnMargin: string;
    blockTop: string;
    rows: Array<{ key: string; y: number; height: number; characters: number; expanded: number }>;
  }> = [];
  let anchor: string | undefined;
  let previous = "";
  let previousRows = "";
  let finalRowsDomMs: number | null = null;
  let frame = 0;
  let readerFrame = 0;
  let readerReady = mode === "end";
  const sample = () => {
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
              thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
              thread.scrollTop -= 240;
              readerReady = true;
            });
          });
        }
        frame = requestAnimationFrame(sample);
        return;
      }
      const viewport = thread.getBoundingClientRect();
      const rows = [...inner.querySelectorAll<HTMLElement>(".chat-virtual-row")].map((row) => {
        const rect = row.getBoundingClientRect();
        if (!anchor && rect.bottom > viewport.top && rect.top < viewport.bottom) {
          anchor = row.dataset.virtualRowKey;
        }
        return {
          key: row.dataset.virtualRowKey ?? "",
          y: rect.y,
          height: rect.height,
          characters: row.textContent?.length ?? 0,
          expanded: row.querySelectorAll("[aria-expanded='true'], details[open]").length,
        };
      });
      const state = {
        scrollTop: thread.scrollTop,
        distanceFromEnd: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
        scrollHeight: thread.scrollHeight,
        clientHeight: thread.clientHeight,
        rangeHeight: inner.style.height,
        columnMargin:
          inner.querySelector<HTMLElement>(".chat-virtual-sizer")?.style.marginTop ?? "",
        blockTop: inner.querySelector<HTMLElement>(".chat-virtual-block")?.style.top ?? "",
        rows,
      };
      const rowSignature = rows
        .map((row) => `${row.key}:${row.height}:${row.characters}`)
        .join("|");
      if (rowSignature !== previousRows) {
        finalRowsDomMs = performance.now();
        previousRows = rowSignature;
      }
      const signature = JSON.stringify(state);
      if (signature !== previous) {
        frames.push({ atMs: performance.now(), ...state });
        previous = signature;
      }
    }
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
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
      const positions = frames.map((sample) => sample.rows.find((row) => row.key === anchor)?.y);
      const visible = positions.filter((value): value is number => value !== undefined);
      const movement = visible
        .slice(1)
        .reduce((sum, y, index) => sum + Math.abs(y - visible[index]!), 0);
      const displacement = visible.length ? Math.abs(visible.at(-1)! - visible[0]!) : 0;
      return {
        mode,
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
