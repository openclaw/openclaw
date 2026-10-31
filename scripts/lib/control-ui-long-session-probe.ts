import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page } from "playwright";
import type { ChatMessageCache } from "../../ui/src/pages/chat/session-message-cache.ts";
import type { ControlUiMockGateway } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type { LongSessionWorkload } from "../../ui/src/test-helpers/control-ui-team-scale-history-fixture.ts";

const paneSelector = ".chat-pane-cache__pane--active";
const needle = "long-session-search-needle";
const cpuMetrics = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];

async function sampleTranscriptScrollFrames(
  element: HTMLElement | SVGElement,
  options: { direction: "top" | "bottom"; trajectory: boolean; count: number },
) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Transcript is not an HTML scroll element");
  }
  const frames: Array<{
    atMs: number;
    intervalMs: number;
    coverage: number;
    rows: number;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }> = [];
  const startedAtMs = performance.now();
  const startTop = element.scrollTop;
  let lastTarget = startTop;
  let previous = performance.now();
  for (let frame = 0; frame < options.count; frame++) {
    const now = await new Promise<number>(requestAnimationFrame);
    const viewport = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")];
    // Retained preparation rows are outside the active range. Measuring their
    // skipped descendants here would turn the coverage probe into scroll work.
    const segments = rows
      .filter((row) => row.dataset.preparedRow !== "true")
      .map((row) => row.getBoundingClientRect())
      .map(
        (rect) =>
          [Math.max(viewport.top, rect.top), Math.min(viewport.bottom, rect.bottom)] as const,
      )
      .filter(([top, bottom]) => bottom > top)
      .toSorted((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = viewport.top;
    for (const [top, bottom] of segments) {
      covered += Math.max(0, bottom - Math.max(top, end));
      end = Math.max(end, bottom);
    }
    frames.push({
      atMs: now,
      intervalMs: now - previous,
      coverage: covered / viewport.height,
      rows: rows.length,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
    previous = now;
    if (options.trajectory && frame < options.count - 1) {
      lastTarget = options.direction === "top" ? 0 : element.scrollHeight - element.clientHeight;
      element.scrollTop = startTop + ((lastTarget - startTop) * (frame + 1)) / (options.count - 1);
    }
  }
  return {
    startedAtMs,
    frames,
    lastTarget,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distancePx:
      options.direction === "top"
        ? element.scrollTop
        : element.scrollHeight - element.clientHeight - element.scrollTop,
    completedAtMs: performance.now(),
  };
}

export function readLongSessionMessageCount(page: Page, sessionKey: string): Promise<number> {
  return page.evaluate((key) => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const cache: ChatMessageCache | undefined = pane
      ? Reflect.get(pane, "chatMessagesBySession")
      : undefined;
    const entry = cache && [...cache].find(([scope]) => scope.endsWith(`\u0000${key}`));
    if (!entry) {
      throw new Error("Long-session measurement requires the active transcript cache owner");
    }
    return entry[1].snapshot.messages.length;
  }, sessionKey);
}

/** Read only metadata and numeric nodes; large edge/string tables never enter the JS heap. */
function countDetachedHeapNodes(file: string) {
  const fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let header = "";
    let start = 0;
    let length = 0;
    while (true) {
      length = readSync(fd, buffer);
      if (!length) {
        throw new Error("Heap snapshot lacks nodes");
      }
      const previousLength = header.length;
      header += buffer.toString("utf8", 0, length);
      const marker = /,\s*"nodes"\s*:\s*\[/u.exec(header);
      if (marker) {
        start = marker.index + marker[0].length - previousLength;
        header = header.slice(0, marker.index);
        break;
      }
    }
    // SAFETY: Only Chromium's schema/count metadata is parsed, before the numeric nodes table.
    const { snapshot } = JSON.parse(`${header}}`) as {
      snapshot: {
        meta: { node_fields: string[]; node_types: (string[] | string)[] };
        node_count: number;
      };
    };
    const fields = snapshot.meta.node_fields;
    const typeAt = fields.indexOf("type");
    const sizeAt = fields.indexOf("self_size");
    const detachedAt = fields.indexOf("detachedness");
    const types = snapshot.meta.node_types[typeAt];
    const count = snapshot.node_count;
    if (
      !fields.length ||
      new Set(fields).size !== fields.length ||
      snapshot.meta.node_types.length !== fields.length ||
      !Array.isArray(types) ||
      !types.includes("native") ||
      typeAt < 0 ||
      sizeAt < 0 ||
      detachedAt < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(count * fields.length)
    ) {
      throw new Error("Heap snapshot lacks valid node fields, count or DOM detachedness");
    }
    let values = 0;
    let value = 0;
    let digits = false;
    let expectValue = true;
    let type = 0;
    let size = 0;
    let detached = 0;
    let detachedNodes = 0;
    let detachedBytes = 0;
    const consume = () => {
      if (!Number.isSafeInteger(value) || values >= count * fields.length) {
        throw new Error("Invalid heap snapshot node value or count");
      }
      const field = values++ % fields.length;
      if (field === typeAt) {
        type = value;
      }
      if (field === sizeAt) {
        size = value;
      }
      if (field === detachedAt) {
        detached = value;
      }
      if (field === fields.length - 1 && types[type] === "native" && detached === 2) {
        detachedNodes++;
        detachedBytes += size;
      }
      value = 0;
      digits = false;
      expectValue = false;
    };
    while (true) {
      for (let index = start; index < length; index++) {
        const char = buffer[index]!;
        if (char >= 48 && char <= 57) {
          if (!expectValue) {
            throw new Error("Heap snapshot node values require commas");
          }
          value = value * 10 + char - 48;
          digits = true;
          continue;
        }
        if (digits) {
          consume();
        }
        if (char === 93) {
          if ((expectValue && values > 0) || values !== count * fields.length) {
            throw new Error("Heap snapshot node count mismatch");
          }
          return { detachedNodes, detachedBytes };
        }
        if (char === 44 && !expectValue) {
          expectValue = true;
        } else if (char !== 32 && char !== 9 && char !== 10 && char !== 13) {
          throw new Error("Invalid heap snapshot nodes array");
        }
      }
      start = 0;
      length = readSync(fd, buffer);
      if (!length) {
        throw new Error("Truncated heap snapshot nodes array");
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** Caller owns the production server, synthetic fixture, and enabled Performance CDP domain. */
export async function probeLongSession(options: {
  page: Page;
  cdp: CDPSession;
  artifactDir: string;
  prefix: string;
  sessionKey: string;
  otherSessionKey: string;
  messageCount: number;
  captureHeap?: boolean;
  scrollCycles?: number;
  workload?: LongSessionWorkload;
}) {
  const {
    page,
    cdp,
    artifactDir,
    prefix,
    sessionKey,
    otherSessionKey,
    messageCount,
    captureHeap = true,
    scrollCycles = 1,
    workload = { scenario: "mixed" },
  } = options;
  const pane = page.locator(paneSelector);
  const movePointerToTranscript = async () => {
    const bounds = await pane.locator(".chat-thread").boundingBox();
    if (!bounds) {
      throw new Error("Transcript is not visible for wheel input");
    }
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  };
  const composer = pane.locator(".agent-chat__composer-combobox textarea");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((entry) => [entry.name, entry.value]),
    );
  const readRpcs = () =>
    page.evaluate(() => {
      // SAFETY: The caller's cold-load init script installs this reader before navigation.
      const probe = Reflect.get(window, "__coldLoad") as {
        read(): { rpcs: Array<{ method: string; ms: number }> };
      };
      return probe.read().rpcs;
    });
  const visible = (key: string) =>
    page.waitForFunction(
      ({ selector, key: targetKey }) => {
        const active = document.querySelector(selector);
        if (!active) {
          return false;
        }
        const host = active.matches("openclaw-chat-pane")
          ? active
          : active.querySelector("openclaw-chat-pane");
        const viewport = active.querySelector(".chat-thread")?.getBoundingClientRect();
        return (
          host &&
          Reflect.get(host, "sessionKey") === targetKey &&
          viewport &&
          [
            ...active.querySelectorAll<HTMLElement>(".chat-virtual-row:not([data-prepared-row])"),
          ].some((row) => {
            const rect = row.getBoundingClientRect();
            return (
              row.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
                contentVisibilityAuto: true,
              }) &&
              rect.bottom > viewport.top &&
              rect.top < viewport.bottom
            );
          })
        );
      },
      { selector: paneSelector, key },
    );
  const ready = async (key: string) => {
    await visible(key);
    await composer.waitFor({ state: "visible" });
    await page.waitForFunction((selector) => {
      const input = document.querySelector<HTMLTextAreaElement>(
        `${selector} .agent-chat__composer-combobox textarea`,
      );
      return input && !input.disabled && !input.readOnly;
    }, paneSelector);
    await composer.focus();
    if (!(await composer.evaluate((input) => input === document.activeElement))) {
      throw new Error("Long-session composer did not accept focus");
    }
  };
  const measure = async <T>(action: () => Promise<T>) => {
    const before = await metrics();
    const rpcOffset = (await readRpcs()).length;
    const start = await page.evaluate(() => performance.now());
    const result = await action();
    const elapsedMs = await page.evaluate((origin) => performance.now() - origin, start);
    const after = await metrics();
    return {
      startMs: start,
      endMs: start + elapsedMs,
      elapsedMs,
      milliseconds: Object.fromEntries(
        cpuMetrics.map((name) => {
          if (before[name] === undefined || after[name] === undefined) {
            throw new Error(`Missing CDP metric: ${name}`);
          }
          return [name, (after[name] - before[name]) * 1000];
        }),
      ),
      rpcs: (await readRpcs()).slice(rpcOffset),
      result,
    };
  };
  const memory = async (stage: string) => {
    const before = { metrics: await metrics(), dom: await cdp.send("Memory.getDOMCounters") };
    await cdp.send("HeapProfiler.collectGarbage");
    const after = { metrics: await metrics(), dom: await cdp.send("Memory.getDOMCounters") };
    const counts = await pane.evaluate((active) => ({
      documentElements: document.querySelectorAll("*").length,
      transcriptElements: active.querySelectorAll(".chat-thread *").length,
      renderedRows: active.querySelectorAll(".chat-virtual-row").length,
      bubbles: active.querySelectorAll(".chat-bubble").length,
      toolRows: active.querySelectorAll(".chat-tool-row").length,
    }));
    if (!captureHeap) {
      return {
        beforeGc: before,
        afterGc: after,
        ...counts,
        detachedNodes: null,
        detachedBytes: null,
        heapSnapshot: null,
      };
    }
    const file = path.join(artifactDir, `${prefix}.${stage}.heapsnapshot`);
    const fd = openSync(file, "wx");
    const onChunk = ({ chunk }: { chunk: string }) => writeSync(fd, chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    try {
      await cdp.send("HeapProfiler.takeHeapSnapshot", { exposeInternals: true });
    } finally {
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
      closeSync(fd);
    }
    const { detachedNodes, detachedBytes } = countDetachedHeapNodes(file);
    return {
      beforeGc: before,
      afterGc: after,
      ...counts,
      detachedNodes,
      detachedBytes,
      heapSnapshot: file,
    };
  };
  await ready(sessionKey);
  const initialMemory = await memory("initial");
  const scroll = async (direction: "top" | "bottom") => {
    const thread = pane.locator(".chat-thread");
    let settledDistancePx: number | undefined;
    const { value, longTasks, maxLongTaskMs, ...timing } = await measureRendered(
      async () => {
        await movePointerToTranscript();
        // Reader input retires initial placement and follow commands before the trajectory.
        await page.mouse.wheel(0, direction === "top" ? -1 : 1);
        const trajectory = await thread.evaluate(sampleTranscriptScrollFrames, {
          direction,
          trajectory: true,
          count: 61,
        });
        // Preserve the synthetic sweep's gap before testing real reader completion.
        let endpoint = await thread.evaluate(sampleTranscriptScrollFrames, {
          direction,
          trajectory: false,
          count: 2,
        });
        const settleFrames = [...endpoint.frames];
        let correction: {
          kind: "native-wheel";
          distancePx: number;
          scrollHeight: number;
          scrollTop: number;
          deltaY: number;
        } | null = null;
        if (endpoint.distancePx > 2) {
          const deltaY =
            (direction === "top" ? -1 : 1) * (endpoint.distancePx + endpoint.clientHeight);
          correction = {
            kind: "native-wheel",
            distancePx: endpoint.distancePx,
            scrollHeight: endpoint.scrollHeight,
            scrollTop: endpoint.scrollTop,
            deltaY,
          };
          await page.mouse.wheel(0, deltaY);
          endpoint = await thread.evaluate(sampleTranscriptScrollFrames, {
            direction,
            trajectory: false,
            count: 2,
          });
          settleFrames.push(...endpoint.frames);
        }
        return {
          endpointProtocol: "native-wheel-v3",
          direction,
          frames: trajectory.frames,
          trajectoryStartMs: trajectory.startedAtMs,
          settleFrames,
          trajectoryEnd: {
            completedAtMs: trajectory.completedAtMs,
            distancePx: trajectory.distancePx,
            scrollHeight: trajectory.scrollHeight,
            scrollTop: trajectory.scrollTop,
            lastTarget: trajectory.lastTarget,
          },
          correction,
          endpointDistancePx: endpoint.distancePx,
          blankFrames: trajectory.frames.filter((frame) => frame.coverage === 0).length,
          maxRows: Math.max(...trajectory.frames.map((frame) => frame.rows)),
          frameGapsOver50Ms: trajectory.frames.filter((frame) => frame.intervalMs > 50).length,
          estimatedDroppedFrames60Hz: trajectory.frames.reduce(
            (sum, frame) => sum + Math.max(0, Math.round(frame.intervalMs / (1000 / 60)) - 1),
            0,
          ),
        };
      },
      async () => {
        settledDistancePx = await thread.evaluate((scroller, destination) => {
          const distance =
            destination === "top"
              ? scroller.scrollTop
              : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
          // Preserve failed endpoints so the report also retains their CPU and long tasks.
          // Acceptance scoring rejects misses; aborting here loses the failed sample.
          return distance;
        }, direction);
      },
      async (error, trajectory) => {
        try {
          await writeFile(
            path.join(artifactDir, `${prefix}.scroll-failure.json`),
            JSON.stringify({ direction, error: String(error), trajectory }, null, 2),
          );
        } catch (captureError) {
          console.warn("Could not save the failed scroll trajectory:", captureError);
        }
      },
      0,
    );
    return { ...timing, result: { ...value, settledDistancePx, longTasks, maxLongTaskMs } };
  };
  const renderFrames = (count = 2) =>
    page.evaluate(async (total) => {
      for (let frame = 0; frame < total; frame++) {
        await new Promise(requestAnimationFrame);
      }
    }, count);
  type ScrollCycle = {
    cycle: number;
    scrollTop?: Awaited<ReturnType<typeof scroll>>;
    scrollBottom: Awaited<ReturnType<typeof scroll>>;
    memory: Awaited<ReturnType<typeof memory>>;
  };
  const repeatScrollCycles = async (
    first: Omit<ScrollCycle, "cycle">,
    beforeMemory?: () => Promise<void>,
  ) => {
    const cycles: ScrollCycle[] = [{ cycle: 1, ...first }];
    for (let cycle = 2; cycle <= scrollCycles; cycle++) {
      const scrollTop = await scroll("top");
      const scrollBottom = await scroll("bottom");
      await beforeMemory?.();
      // GC and heap snapshots must never enter either direction's action timing.
      cycles.push({
        cycle,
        scrollTop,
        scrollBottom,
        memory: await memory(`scroll-cycle-${cycle}`),
      });
    }
    return cycles;
  };
  const measureRendered = async <T>(
    action: () => Promise<T>,
    afterRender?: () => Promise<void>,
    onFailure?: (error: unknown, value: T | undefined) => Promise<void>,
    settleFrameCount = 2,
  ) => {
    const measured = await measure(async () => {
      await page.evaluate(() => {
        const longTasks: Array<{ startMs: number; durationMs: number }> = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
          }
        });
        observer.observe({ type: "longtask" });
        Reflect.set(window, "__longSessionAction", { observer, longTasks });
      });
      let value: T | undefined;
      try {
        value = await action();
        if (settleFrameCount > 0) {
          await renderFrames(settleFrameCount);
        }
        if (afterRender) {
          await afterRender();
        }
        const sample = await page.evaluate(() => {
          // SAFETY: The action installs this document-scoped observer before its first effect.
          const state = Reflect.get(window, "__longSessionAction") as {
            observer: PerformanceObserver;
            longTasks: Array<{ startMs: number; durationMs: number }>;
          };
          for (const entry of state.observer.takeRecords()) {
            state.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
          }
          return {
            longTasks: state.longTasks,
            maxLongTaskMs: Math.max(0, ...state.longTasks.map((entry) => entry.durationMs)),
          };
        });
        return { value, ...sample };
      } catch (error) {
        await onFailure?.(error, value);
        throw error;
      } finally {
        await page.evaluate(() => {
          Reflect.get(window, "__longSessionAction")?.observer.disconnect();
          Reflect.deleteProperty(window, "__longSessionAction");
        });
      }
    });
    const { result, ...timing } = measured;
    return { ...timing, ...result };
  };
  const save = async <T extends object>(result: T) => {
    const report = {
      measurement:
        "Synthetic production UI; automation-to-visible/focus wall time and CDP duration deltas. Dedicated actions end after their DOM identity assertions and two rendering opportunities, not compositor presentation. Scroll includes real wheel admission, a 61-sample programmatic scrollTop trajectory and two sampled settling frames. Its raw endpoint gap remains recorded. If needed, one native wheel input and two more sampled frames measure user-directed endpoint completion; the final endpoint must be within two pixels. Both phases remain inside the measured action. One observer covers that entire action. Geometric row coverage is not compositor paint proof. Explicit GC and heap snapshots are outside action timings. CPU includes measurement overhead; compare identical paired instrumentation.",
      scenario: workload.scenario,
      sessionKey,
      initialMemory,
      ...result,
    };
    await writeFile(
      path.join(artifactDir, `${prefix}.long-session.json`),
      JSON.stringify(report, null, 2),
    );
    return report;
  };
  const entry = (id: string) => pane.locator(`.chat-bubble[data-entry-id=${JSON.stringify(id)}]`);
  if (workload.scenario === "paging") {
    const loadedCount = await pane.evaluate(
      (host) => Reflect.get(host, "state").chatMessages.length,
    );
    if (loadedCount !== workload.initialMessageCount) {
      throw new Error(
        `Paging started with ${loadedCount} records; expected ${workload.initialMessageCount}`,
      );
    }
    const stages = [];
    for (const expectedPage of workload.pages) {
      await movePointerToTranscript();
      await page.mouse.wheel(0, -1_000_000);
      const request = await page.waitForFunction(
        ({ key, cursor }) => {
          const gateway: ControlUiMockGateway = Reflect.get(window, "openclawControlUiE2eGateway");
          return gateway.findRequests("chat.history", { sessionKey: key, cursor })[0];
        },
        { key: sessionKey, cursor: expectedPage.cursor },
      );
      const recorded = await request.jsonValue();
      await request.dispose();
      if (!recorded) {
        throw new Error("Older history request was not recorded");
      }
      if (
        Reflect.get(recorded.params ?? {}, "limit") !== 1000 ||
        Reflect.get(recorded.params ?? {}, "maxBytes") !== 3 * 1024 * 1024
      ) {
        throw new Error(
          "Older history request did not use its production 1000-record/3MiB page contract",
        );
      }
      const anchor = entry(expectedPage.anchorEntryId);
      await anchor.waitFor({ state: "visible" });
      await renderFrames();
      const before = await anchor.boundingBox();
      if (!before) {
        throw new Error("History anchor has no visible box");
      }
      const anchorSample = await anchor.evaluateHandle((original) => {
        const owner = original.closest("openclaw-chat-pane");
        const selector = `.chat-bubble[data-entry-id="${CSS.escape(original.getAttribute("data-entry-id")!)}"]`;
        const state = { stop: false, positions: [] as Array<number | null> };
        void (async () => {
          while (!state.stop) {
            state.positions.push(
              owner?.querySelector(selector)?.getBoundingClientRect().top ?? null,
            );
            await new Promise(requestAnimationFrame);
          }
        })();
        return state;
      });
      try {
        const timing = await measureRendered(async () => {
          await page.evaluate(
            ({ key, cursor }) => {
              const gateway: ControlUiMockGateway = Reflect.get(
                window,
                "openclawControlUiE2eGateway",
              );
              gateway.resolveDeferred("chat.history", undefined, {
                match: { sessionKey: key, cursor },
              });
            },
            { key: sessionKey, cursor: expectedPage.cursor },
          );
          await page.waitForFunction(
            ({ selector, count }) =>
              Reflect.get(document.querySelector(selector)!, "state").chatMessages.length === count,
            { selector: paneSelector, count: expectedPage.loadedMessages },
          );
          // Trace eight post-publication frames rather than just the final anchor position.
          await renderFrames(8);
        });
        const positions = await anchorSample.evaluate((state) => {
          state.stop = true;
          return state.positions;
        });
        const maxDisplacementPx = Math.max(
          ...positions.map((top) => (top === null ? Infinity : Math.abs(top - before.y))),
        );
        if (maxDisplacementPx > 2) {
          throw new Error(`History prepend displaced the reading anchor by ${maxDisplacementPx}px`);
        }
        stages.push({
          ...expectedPage,
          ...timing,
          positions,
          maxDisplacementPx,
          memory: await memory(`history-${expectedPage.loadedMessages}`),
        });
      } finally {
        await anchorSample.evaluate((state) => {
          state.stop = true;
        });
        await anchorSample.dispose();
      }
      await page.screenshot({
        path: path.join(artifactDir, `${prefix}.history-${expectedPage.loadedMessages}.png`),
      });
    }
    await movePointerToTranscript();
    await page.mouse.wheel(0, -1_000_000);
    await entry(workload.firstEntryId).waitFor({ state: "visible" });
    await pane.locator(".chat-history-sentinel").waitFor({ state: "detached" });
    const cursors = await page.evaluate(
      ({ key, deltaCursor }) => {
        const gateway: ControlUiMockGateway = Reflect.get(window, "openclawControlUiE2eGateway");
        return gateway
          .findRequests("chat.history", { sessionKey: key })
          .map((request) => Reflect.get(request.params ?? {}, "cursor"))
          .filter((cursor) => typeof cursor === "string" && cursor !== deltaCursor);
      },
      { key: sessionKey, deltaCursor: workload.deltaCursor },
    );
    if (
      JSON.stringify(cursors) !==
      JSON.stringify(workload.pages.map((expectedPage) => expectedPage.cursor))
    ) {
      throw new Error(`Unexpected older history request cursors: ${JSON.stringify(cursors)}`);
    }
    const scrollBottom = await scroll("bottom");
    const afterScroll = await memory("after-scroll");
    const cycles =
      scrollCycles > 1
        ? await repeatScrollCycles({ scrollBottom, memory: afterScroll })
        : undefined;
    return save({
      messageCount: workload.messageCount,
      stages,
      cursors,
      scrollBottom,
      ...(cycles ? { scrollCycles: cycles } : {}),
      finalMemory: cycles?.at(-1)?.memory ?? afterScroll,
    });
  }
  if (workload.scenario === "single-run" || workload.scenario === "direct-run") {
    await entry(workload.lastEntryId).waitFor({ state: "visible" });
    let disclosure;
    if (workload.scenario === "single-run") {
      const summary = pane.locator(".chat-work-group .chat-activity-group__summary");
      if (
        (await summary.count()) !== 1 ||
        (await summary.getAttribute("aria-expanded")) !== "false"
      ) {
        throw new Error("Single-run dashboard must start with one collapsed work disclosure");
      }
      const expand = await measureRendered(async () => {
        await summary.click();
        await page.waitForFunction(
          (selector) =>
            document
              .querySelector(`${selector} .chat-work-group .chat-activity-group__summary`)
              ?.getAttribute("aria-expanded") === "true",
          paneSelector,
        );
        await entry(workload.firstOutputEntryId).waitFor({ state: "visible" });
      });
      disclosure = { expand, expandedMemory: await memory("expanded") };
      await page.screenshot({ path: path.join(artifactDir, `${prefix}.expanded.png`) });
    }
    const scrollTop = await scroll("top");
    await entry(workload.firstEntryId).waitFor({ state: "visible" });
    const scrollBottom = await scroll("bottom");
    await entry(workload.lastEntryId).waitFor({ state: "visible" });
    const firstScrollMemory = await memory("after-scroll");
    const cycles =
      scrollCycles > 1
        ? await repeatScrollCycles({ scrollTop, scrollBottom, memory: firstScrollMemory })
        : undefined;
    const afterScroll = cycles?.at(-1)?.memory ?? firstScrollMemory;
    await page.screenshot({ path: path.join(artifactDir, `${prefix}.bottom.png`) });
    let collapse;
    if (workload.scenario === "single-run") {
      // A fragmented run does not retain its offscreen disclosure at the bottom.
      await pane.locator(".chat-thread").evaluate((thread) => {
        thread.scrollTop = 0;
      });
      await pane
        .locator(".chat-work-group .chat-activity-group__summary")
        .waitFor({ state: "visible" });
      collapse = await measureRendered(async () => {
        await pane.locator(".chat-work-group .chat-activity-group__summary").click();
        await page.waitForFunction(
          (selector) =>
            document
              .querySelector(`${selector} .chat-work-group .chat-activity-group__summary`)
              ?.getAttribute("aria-expanded") === "false",
          paneSelector,
        );
        await entry(workload.lastEntryId).waitFor({ state: "visible" });
      });
    }
    return save({
      messageCount: workload.messageCount,
      disclosure,
      scrollTop,
      scrollBottom,
      ...(cycles ? { scrollCycles: cycles } : {}),
      afterScroll,
      collapse,
      finalMemory: collapse ? await memory("final") : afterScroll,
    });
  }
  const switchTo = (key: string) =>
    measure(async () => {
      const link = page.locator(
        `.sidebar-recent-session[data-session-key=${JSON.stringify(key)}] a.sidebar-recent-session__link`,
      );
      await link.waitFor({ state: "visible" });
      const start = await page.evaluate(() => performance.now());
      await link.click();
      await visible(key);
      const visibleMs = await page.evaluate((origin) => performance.now() - origin, start);
      await ready(key);
      const loadedMessages =
        key === sessionKey ? await readLongSessionMessageCount(page, key) : undefined;
      if (key === sessionKey && loadedMessages !== messageCount) {
        throw new Error(
          `Long-session switch loaded ${loadedMessages} messages; expected ${messageCount}`,
        );
      }
      return { sessionKey: key, visibleMs, loadedMessages };
    });
  const switchOut = await switchTo(otherSessionKey);
  const switchIn = await switchTo(sessionKey);
  const search = await measure(async () => {
    const shortcut = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
    );
    await page.keyboard.press(shortcut);
    const input = pane.getByRole("textbox", { name: "Search messages", exact: true });
    await input.fill(needle);
    await page.waitForFunction(
      ({ selector, query }) => {
        const thread = document.querySelector(`${selector} .chat-thread`);
        if (!thread) {
          return false;
        }
        const viewport = thread.getBoundingClientRect();
        return [...thread.querySelectorAll<HTMLElement>(".chat-text")].some((text) => {
          const rect = text.getBoundingClientRect();
          return (
            text.textContent?.includes(query) &&
            text.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
              contentVisibilityAuto: true,
            }) &&
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom
          );
        });
      },
      { selector: paneSelector, query: needle },
    );
    return { query: needle, renderedRows: await pane.locator(".chat-virtual-row").count() };
  });
  await page.screenshot({ path: path.join(artifactDir, `${prefix}.search.png`) });
  const clearSearch = await measure(async () => {
    await pane.getByRole("button", { name: "Close search", exact: true }).click();
    await pane.locator(".agent-chat__search-bar").waitFor({ state: "detached" });
    await ready(sessionKey);
  });
  const scrollTop = await scroll("top");
  const scrollBottom = await scroll("bottom");
  const settleBottomWidget = () =>
    pane
      .frameLocator(".chat-tool-card__preview-frame")
      .last()
      .frameLocator("iframe")
      .getByText("Team metric 12", { exact: true })
      .waitFor();
  if (scrollCycles > 1) {
    // Compare settled widget ownership in every repeated memory sample.
    await settleBottomWidget();
  }
  const firstScrollMemory = await memory("after-scroll");
  const cycles =
    scrollCycles > 1
      ? await repeatScrollCycles(
          { scrollTop, scrollBottom, memory: firstScrollMemory },
          settleBottomWidget,
        )
      : undefined;
  const finalMemory = cycles?.at(-1)?.memory ?? firstScrollMemory;
  // Single-cycle runs retain their capture-only widget readiness wait.
  await settleBottomWidget();
  await page.screenshot({ path: path.join(artifactDir, `${prefix}.bottom.png`) });
  return save({
    otherSessionKey,
    switchOut,
    switchIn,
    search,
    clearSearch,
    scrollTop,
    scrollBottom,
    ...(cycles ? { scrollCycles: cycles } : {}),
    finalMemory,
  });
}
