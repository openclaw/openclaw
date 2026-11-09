import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JSHandle, Page } from "playwright";
import { observeTranscriptPaint } from "./control-ui-transcript-paint-probe.ts";

/** Diagnostic only: DOM reads and compositor capture invalidate timing comparisons. */
function observeTranscriptLayout(diagnosticOptions: { paintMarker: boolean }) {
  const thread =
    document.querySelector<HTMLElement>(".chat-pane-cache__pane--active .chat-thread") ??
    document.querySelector<HTMLElement>(".chat-thread");
  if (!thread) {
    throw new Error("Transcript layout audit requires a mounted chat thread");
  }
  const scope = thread.closest(".chat-pane-cache__pane") ?? thread.parentElement!;
  const frames: unknown[] = [];
  const mutations: unknown[] = [];
  const input: unknown[] = [];
  const scrollWrites: unknown[] = [];
  const ids = new WeakMap<Node, number>();
  let nextId = 0;
  let droppedFrames = 0;
  let droppedMutations = 0;
  let previousOffset = thread.scrollTop;
  let previousViewportTop = thread.getBoundingClientRect().top;
  let previousRows = new Map<number, number>();
  let stopped = false;
  let frame = 0;
  let writeRevision = 0;
  let markerScrollTop: number | undefined;
  let marker: HTMLCanvasElement | undefined;
  let markerContext: CanvasRenderingContext2D | null = null;
  if (diagnosticOptions.paintMarker) {
    markerScrollTop = thread.scrollTop;
    marker = document.createElement("canvas");
    marker.width = 108;
    marker.height = 12;
    marker.setAttribute("aria-hidden", "true");
    Object.assign(marker.style, {
      position: "fixed",
      left: "0",
      bottom: "0",
      display: "block",
      width: "108px",
      height: "12px",
      pointerEvents: "none",
      zIndex: "2147483647",
      contain: "strict",
    });
    markerContext = marker.getContext("2d", { alpha: false });
    if (!markerContext) {
      throw new Error("Transcript pixel marker requires a 2D canvas context");
    }
    markerContext.fillStyle = "#000";
    markerContext.fillRect(0, 0, 108, 12);
    markerContext.fillStyle = "#fff";
    markerContext.fillRect(6, 0, 6, 12);
    document.body.append(marker);
  }
  const markWrite = () => {
    writeRevision = (writeRevision + 1) & 0xffff;
    if (!markerContext) {
      return;
    }
    markerScrollTop = thread.scrollTop;
    markerContext.fillStyle = "#000";
    markerContext.fillRect(12, 0, 96, 12);
    markerContext.fillStyle = "#fff";
    for (let bit = 0; bit < 16; bit++) {
      if (writeRevision & (1 << bit)) {
        markerContext.fillRect((bit + 2) * 6, 0, 6, 12);
      }
    }
  };
  const scrollToDescriptor = Object.getOwnPropertyDescriptor(thread, "scrollTo");
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(thread, "scrollTop");
  const nativeScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  const nativeScrollTo = thread.scrollTo.bind(thread);
  Object.defineProperty(thread, "scrollTop", {
    configurable: true,
    get() {
      return nativeScrollTop.get!.call(thread);
    },
    set(value: number) {
      const before = thread.scrollTop;
      nativeScrollTop.set!.call(thread, value);
      markWrite();
      if (scrollWrites.length < 6_000) {
        scrollWrites.push({
          at: performance.now(),
          writeRevision,
          api: "scrollTop",
          before,
          requested: value,
          after: thread.scrollTop,
        });
      }
    },
  });
  thread.scrollTo = (options: ScrollToOptions | number = {}, y?: number) => {
    const before = thread.scrollTop;
    if (typeof options === "number") {
      nativeScrollTo(options, y ?? 0);
    } else {
      nativeScrollTo(options);
    }
    markWrite();
    if (scrollWrites.length < 6_000) {
      scrollWrites.push({
        at: performance.now(),
        writeRevision,
        api: "scrollTo",
        before,
        requested: typeof options === "number" ? y : options.top,
        after: thread.scrollTop,
      });
    }
  };
  const id = (node: Node) => {
    let value = ids.get(node);
    if (value === undefined) {
      value = ++nextId;
      ids.set(node, value);
    }
    return value;
  };
  const ancestry = (node: Node) => {
    const chain = [];
    for (
      let current: Node | null = node;
      current && chain.length < 8;
      current = current.parentNode
    ) {
      const element = current instanceof Element ? current : null;
      chain.push({
        id: id(current),
        tag: current.nodeName,
        classes: element?.getAttribute("class"),
        row: element?.getAttribute("data-virtual-row-key"),
        index: element?.getAttribute("data-index"),
      });
      if (current === scope) {
        break;
      }
    }
    return chain;
  };
  const collect = (records: MutationRecord[]) => {
    for (const record of records) {
      if (mutations.length >= 6_000) {
        droppedMutations++;
        continue;
      }
      const element =
        record.target instanceof Element ? record.target : record.target.parentElement;
      if (!element?.closest(".chat-thread, .agent-chat__composer")) {
        continue;
      }
      mutations.push({
        at: performance.now(),
        type: record.type,
        target: ancestry(record.target),
        attribute: record.attributeName,
        oldLength: record.oldValue?.length,
        newLength: record.type === "characterData" ? record.target.nodeValue?.length : undefined,
        value:
          record.type === "attributes" && record.attributeName !== "style"
            ? element.getAttribute(record.attributeName!)?.slice(0, 200)
            : undefined,
        style:
          record.attributeName === "style" && element instanceof HTMLElement
            ? ["height", "min-height", "top", "margin-top", "display", "content-visibility"].map(
                (property) => [property, element.style.getPropertyValue(property)],
              )
            : undefined,
        added: [...record.addedNodes].slice(0, 12).map(ancestry),
        removed: [...record.removedNodes].slice(0, 12).map(ancestry),
      });
    }
  };
  const observer = new MutationObserver(collect);
  observer.observe(scope, {
    subtree: true,
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      "class",
      "style",
      "data-row-size",
      "data-prepared-row",
      "data-preparing-row",
      "data-streaming-row",
    ],
  });
  const onInput = (event: Event) => {
    if (input.length < 2_000) {
      input.push({
        at: performance.now(),
        type: event.type,
        trusted: event.isTrusted,
        scrollTop: thread.scrollTop,
        deltaY: event instanceof WheelEvent ? event.deltaY : undefined,
        deltaMode: event instanceof WheelEvent ? event.deltaMode : undefined,
      });
    }
  };
  scope.addEventListener("wheel", onInput, { passive: true, capture: true });
  scope.addEventListener("input", onInput, true);
  const hasVisibleRowStyle = (row: HTMLElement) =>
    row.dataset.preparedRow !== "true" ||
    (row.style.opacity !== "0" && row.style.display !== "none");
  const sample = () => {
    if (stopped) {
      return;
    }
    if (frames.length < 3_600) {
      const viewport = thread.getBoundingClientRect();
      const offset = thread.scrollTop;
      const scrollDelta = offset - previousOffset;
      const viewportDelta = viewport.top - previousViewportTop;
      const rows = [...thread.querySelectorAll<HTMLElement>("[data-virtual-row-key]")]
        .filter(hasVisibleRowStyle)
        .map((row) => {
          const rect = row.getBoundingClientRect();
          const previous = previousRows.get(id(row));
          return {
            id: id(row),
            key: row.dataset.virtualRowKey,
            index: row.dataset.index,
            prepared: row.dataset.preparedRow === "true",
            preparing: row.dataset.preparingRow === "true",
            top: rect.top,
            height: rect.height,
            size: row.dataset.rowSize,
            screenDeltaY: previous === undefined ? null : rect.top - previous,
            // Zero means motion is fully explained by native scrolling/viewport movement.
            layoutDeltaY:
              previous === undefined ? null : rect.top - previous + scrollDelta - viewportDelta,
          };
        })
        .filter((row) => row.top + row.height > viewport.top && row.top < viewport.bottom)
        .slice(0, 32);
      const block = thread.querySelector<HTMLElement>(".chat-virtual-block");
      const blockRect = block?.getBoundingClientRect();
      // Text rectangles establish DOM readiness, not whether those pixels painted.
      // Skip parked descendants before layout reads, as the scroll probe does.
      const visibleBubbles = [
        ...thread.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]"),
      ]
        .filter((bubble) => {
          const row = bubble.closest<HTMLElement>("[data-virtual-row-key]");
          return !row || hasVisibleRowStyle(row);
        })
        .map((bubble) => ({ bubble, rect: bubble.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom);
      const bubbles = visibleBubbles.slice(0, 32).map(({ bubble, rect }) => {
        const text = bubble.querySelector<HTMLElement>(".chat-text");
        const textRects: Array<{ left: number; top: number; width: number; height: number }> = [];
        let visibleTextRectCount = 0;
        if (text) {
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) {
              continue;
            }
            range.selectNodeContents(node);
            for (const part of range.getClientRects()) {
              if (
                part.width > 0 &&
                part.height > 0 &&
                part.bottom > viewport.top &&
                part.top < viewport.bottom &&
                part.right > viewport.left &&
                part.left < viewport.right
              ) {
                visibleTextRectCount++;
                if (textRects.length < 32) {
                  textRects.push({
                    left: part.left,
                    top: part.top,
                    width: part.width,
                    height: part.height,
                  });
                }
              }
            }
          }
        }
        return {
          id: id(bubble),
          entryId: bubble.dataset.entryId,
          rowKey: bubble.closest<HTMLElement>("[data-virtual-row-key]")?.dataset.virtualRowKey,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          textLength: text?.textContent?.trim().length ?? 0,
          visibleTextRectCount,
          textRects,
          omittedTextRects: visibleTextRectCount - textRects.length,
        };
      });
      const markdown = [...thread.querySelectorAll<HTMLElement>(".streaming .chat-text > *")]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { id: id(node), tag: node.localName, top: rect.top, height: rect.height };
        })
        .filter((node) => node.top + node.height > viewport.top && node.top < viewport.bottom);
      frames.push({
        at: performance.now(),
        delivered: Reflect.get(window, "__streamingReply")?.read().delivered,
        scrollTop: offset,
        writeRevision,
        markerScrollTop,
        scrollDelta,
        scrollHeight: thread.scrollHeight,
        clientHeight: thread.clientHeight,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        viewportLeft: viewport.left,
        viewportRight: viewport.right,
        block: { top: blockRect?.top, height: blockRect?.height, cssTop: block?.style.top },
        rows,
        bubbles,
        omittedBubbles: Math.max(0, visibleBubbles.length - bubbles.length),
        preparingRows: thread.querySelectorAll('[data-preparing-row="true"]').length,
        markdown,
      });
      previousRows = new Map(rows.map((row) => [row.id, row.top]));
      previousOffset = offset;
      previousViewportTop = viewport.top;
    } else {
      droppedFrames++;
    }
    frame = requestAnimationFrame(sample);
  };
  sample();
  return {
    finish() {
      stopped = true;
      cancelAnimationFrame(frame);
      collect(observer.takeRecords());
      observer.disconnect();
      marker?.remove();
      scope.removeEventListener("wheel", onInput, true);
      scope.removeEventListener("input", onInput, true);
      if (scrollTopDescriptor) {
        Object.defineProperty(thread, "scrollTop", scrollTopDescriptor);
      } else {
        Reflect.deleteProperty(thread, "scrollTop");
      }
      if (scrollToDescriptor) {
        Object.defineProperty(thread, "scrollTo", scrollToDescriptor);
      } else {
        Reflect.deleteProperty(thread, "scrollTo");
      }
      return {
        timeOrigin: performance.timeOrigin,
        frames,
        mutations,
        input,
        scrollWrites,
        pixelMarker: marker
          ? {
              left: 0,
              bottom: 0,
              cellWidth: 6,
              cellHeight: 12,
              referenceCells: ["black", "white"],
              bits: 16,
              bitOrder: "least-significant-first",
            }
          : undefined,
        droppedFrames,
        droppedMutations,
      };
    },
  };
}

export async function startTranscriptLayoutAudit(
  page: Page,
  directory: string,
  prefix: string,
  engine: string,
  paintMarker = false,
  paintProbe = false,
) {
  const frameDirectory = path.join(directory, `${prefix}.transcript-frames`);
  await mkdir(frameDirectory, { recursive: true });
  const observation: JSHandle<
    ReturnType<typeof observeTranscriptPaint> | ReturnType<typeof observeTranscriptLayout>
  > = paintProbe
    ? await page.evaluateHandle(observeTranscriptPaint)
    : await page.evaluateHandle(observeTranscriptLayout, { paintMarker });
  const images: unknown[] = [];
  const writes: Promise<void>[] = [];
  const errors: string[] = [];
  let imageBytes = 0;
  let droppedImages = 0;
  const onFrame = ({
    data: bytes,
    timestamp,
    viewportWidth,
    viewportHeight,
  }: {
    data: Buffer;
    timestamp: number;
    viewportWidth: number;
    viewportHeight: number;
  }) => {
    if (images.length >= 900 || imageBytes + bytes.length > 100 * 1024 * 1024) {
      droppedImages++;
      return;
    }
    imageBytes += bytes.length;
    const file = `frame-${String(images.length).padStart(4, "0")}.jpg`;
    // Preserve the audit's epoch-seconds image clock for existing analyzers.
    images.push({
      file,
      timestamp: timestamp / 1_000,
      deviceWidth: viewportWidth,
      deviceHeight: viewportHeight,
    });
    writes.push(
      writeFile(path.join(frameDirectory, file), bytes).catch((error: unknown) => {
        errors.push(String(error));
      }),
    );
  };
  try {
    await page.screencast.start({
      onFrame,
      quality: 65,
      size: { width: 1440, height: 1000 },
    });
  } catch (error) {
    await observation.evaluate((audit) => {
      audit.finish();
      if ("dispose" in audit) {
        audit.dispose();
      }
    });
    await observation.dispose();
    throw error;
  }
  return {
    async finish() {
      try {
        const geometry = await observation.evaluate((audit) => audit.finish());
        await page.screencast.stop();
        await Promise.all(writes);
        const paintCalibrations = [];
        if (paintProbe) {
          for (const offset of [0, 8191, 13979]) {
            const result = await observation.evaluate(
              async (audit, top) =>
                "calibrate" in audit ? audit.calibrate(top) : { scrollTop: 0 },
              offset,
            );
            const file: string = `calibration-${paintCalibrations.length}.jpg`;
            await page.screenshot({
              path: path.join(frameDirectory, file),
              type: "jpeg",
              quality: 65,
            });
            const after = await page
              .locator(".chat-pane-cache__pane--active .chat-thread")
              .evaluate((thread) => ({
                scrollTop: thread.scrollTop,
                scrollHeight: thread.scrollHeight,
              }));
            paintCalibrations.push({ file, ...result, after });
          }
        }
        await writeFile(
          path.join(directory, `${prefix}.transcript-layout.json`),
          JSON.stringify(
            {
              ...geometry,
              paintCalibrations,
              images,
              imageBytes,
              droppedImages,
              errors,
              captureSource: `${engine}:playwright-screencast`,
              notes: paintProbe
                ? [
                    "Capture-only probe: synchronous layout reads and extra paint invalidate timing comparisons.",
                    "The fixed canvas encodes a snapshot ID. The CSS local background encodes compositor scroll offset independently. Content and marker layers are not an atomic presentation fence.",
                    "Each snapshot copies the live virtualizer range/offset and the committed active keys alongside mounted row visibility and text geometry. The live range can precede the rendered DOM.",
                    "JPEG counts are capture counts, not display refresh counts or blank duration. Chromium image timestamps are frame-swap time; they do not identify the DOM revision in each independent layer.",
                    "Calibration requires stable scroll offset and extent before capture, with both recorded again afterward. Pixel text rectangles are layout bounds, not glyph masks.",
                  ]
                : [
                    "Diagnostic DOM reads and compositor capture add overhead; these results are not timing proof.",
                    "JPEGs come from the browser screencast in every engine; image counts are capture counts, not display refresh counts or blank duration.",
                    "Geometry at is performance.now(); image timestamp is seconds since Unix epoch. Compare timestamp * 1000 - timeOrigin, allowing compositor pipeline delay. Playwright aligns Firefox/WebKit's screencast clock to host wall time at the first frame, so their cross-clock ordering is approximate.",
                    "rAF row, bubble and text rectangles describe DOM layout before paint. They do not establish painted coverage or rule out stale text. Prepared rows with hidden inline styles are excluded before descendant layout reads; visible prepared rows are included. preparingRows counts measurement candidates separately.",
                    "Bubble IDs and bounded text rectangles aid image attribution without retaining message text. Omitted bubble/text counts identify truncated samples; text rectangles are not glyph masks.",
                    "When enabled, the bottom-left pixel marker encodes the latest wrapped JavaScript scroll write revision after two black/white reference cells. Match it to scrollWrites rather than relying on cross-clock ordering. Native compositor scrolls do not increment it; markerScrollTop records the offset when its revision was written. The diagnostic marker itself adds paint work and is excluded from ordinary audits.",
                    "screenDeltaY is visible same-node movement; layoutDeltaY removes native scroll and viewport movement. Compensation can keep screenDeltaY zero while layoutDeltaY changes.",
                    "Mutation ancestry contains identities and text lengths, never message text. Removed nodes may already lack parents at observer delivery.",
                  ],
            },
            null,
            2,
          ),
        );
      } finally {
        if (paintProbe) {
          await observation.evaluate((audit) => {
            if ("dispose" in audit) {
              audit.dispose();
            }
          });
        }
        await observation.dispose();
      }
    },
  };
}
