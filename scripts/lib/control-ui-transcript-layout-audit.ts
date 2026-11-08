import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

/** Diagnostic only: DOM reads and compositor capture invalidate timing comparisons. */
function observeTranscriptLayout() {
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
      if (scrollWrites.length < 6_000) {
        scrollWrites.push({
          at: performance.now(),
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
    if (scrollWrites.length < 6_000) {
      scrollWrites.push({
        at: performance.now(),
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
    attributeFilter: ["class", "style", "data-row-size", "data-prepared-row", "data-streaming-row"],
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
        .filter((row) => row.dataset.preparedRow !== "true")
        .map((row) => {
          const rect = row.getBoundingClientRect();
          const previous = previousRows.get(id(row));
          return {
            id: id(row),
            key: row.dataset.virtualRowKey,
            index: row.dataset.index,
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
        scrollDelta,
        scrollHeight: thread.scrollHeight,
        clientHeight: thread.clientHeight,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        block: { top: blockRect?.top, height: blockRect?.height, cssTop: block?.style.top },
        rows,
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
) {
  const frameDirectory = path.join(directory, `${prefix}.transcript-frames`);
  const session = engine === "chromium" ? await page.context().newCDPSession(page) : undefined;
  if (session) {
    await mkdir(frameDirectory, { recursive: true });
  }
  const observation = await page
    .evaluateHandle(observeTranscriptLayout)
    .catch(async (error: unknown) => {
      await session?.detach();
      throw error;
    });
  const images: unknown[] = [];
  const writes: Promise<void>[] = [];
  const errors: string[] = [];
  let imageBytes = 0;
  let droppedImages = 0;
  session?.on("Page.screencastFrame", (event) => {
    void session
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch((error: unknown) => {
        if (errors.length < 10) {
          errors.push(String(error));
        }
      });
    const bytes = Buffer.from(event.data, "base64");
    if (images.length >= 900 || imageBytes + bytes.length > 100 * 1024 * 1024) {
      droppedImages++;
      return;
    }
    imageBytes += bytes.length;
    const file = `frame-${String(images.length).padStart(4, "0")}.jpg`;
    images.push({ file, ...event.metadata });
    writes.push(
      writeFile(path.join(frameDirectory, file), bytes).catch((error: unknown) => {
        errors.push(String(error));
      }),
    );
  });
  try {
    await session?.send("Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: 1440,
      maxHeight: 1000,
      everyNthFrame: 1,
    });
  } catch (error) {
    await observation.evaluate((audit) => audit.finish());
    await observation.dispose();
    await session?.detach();
    throw error;
  }
  return {
    async finish() {
      try {
        const geometry = await observation.evaluate((audit) => audit.finish());
        await session?.send("Page.stopScreencast");
        await Promise.all(writes);
        await writeFile(
          path.join(directory, `${prefix}.transcript-layout.json`),
          JSON.stringify(
            {
              ...geometry,
              images,
              imageBytes,
              droppedImages,
              errors,
              notes: [
                "Diagnostic DOM reads and compositor capture add overhead; these results are not timing proof.",
                "Compositor frames are available only in Chromium; other engines record DOM geometry and native scroll writes.",
                "Geometry at is performance.now(); screencast timestamp is seconds since Unix epoch. Compare timestamp * 1000 - timeOrigin, allowing compositor pipeline delay.",
                "screenDeltaY is visible same-node movement; layoutDeltaY removes native scroll and viewport movement. Compensation can keep screenDeltaY zero while layoutDeltaY changes.",
                "Mutation ancestry contains identities and text lengths, never message text. Removed nodes may already lack parents at observer delivery.",
              ],
            },
            null,
            2,
          ),
        );
      } finally {
        await observation.dispose();
        await session?.detach();
      }
    },
  };
}
