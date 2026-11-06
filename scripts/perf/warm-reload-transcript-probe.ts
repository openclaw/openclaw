/** Retained-row geometry shared by warm-reload proof and browser regressions. */
export function installWarmReloadTranscriptProbe(mode: "reader" | "end" = "end") {
  const frames: Array<{
    atMs: number;
    scrollTop: number;
    distanceFromEnd: number;
    rows: Array<{ key: string; y: number; height: number; characters: number; size: number }>;
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
      const rows = [
        ...inner.querySelectorAll<HTMLElement>(".chat-virtual-row:not([data-prepared-row])"),
      ].map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          key: row.dataset.virtualRowKey ?? "",
          y: rect.y,
          height: rect.height,
          characters: row.textContent?.length ?? 0,
          size: Number.parseFloat(row.style.containIntrinsicBlockSize),
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
