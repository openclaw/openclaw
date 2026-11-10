import type { Page } from "playwright";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleHistoryFixture } from "../../ui/src/test-helpers/control-ui-team-scale-history-fixture.ts";
import { engineProbeInitScript, type EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import {
  readLongSessionMessageCount,
  sampleTranscriptScrollFrames,
} from "./control-ui-long-session-probe.ts";

const directKey = "agent:main:interaction-a";
const dashboardKey = "agent:main:dashboard:engine-completed-run";
const activePane = ".chat-pane-cache__pane--active";
const threadSelector = `${activePane} .chat-thread`;
const summarySelector = `${activePane} .chat-work-group > .chat-activity-group__summary`;
const entrySelector = (index: number) =>
  `${activePane} .chat-bubble:not(.chat-bubble--tool-shell)[data-entry-id="team-message-${index}"]`;

async function ready(page: Page, sessionKey: string, messageCount: number) {
  await page.locator(entrySelector(messageCount)).waitFor({ state: "visible" });
  await page.waitForFunction((selector) => {
    const pane = document.querySelector(selector);
    const composer = pane?.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    );
    return Reflect.get(pane ?? {}, "transcriptReady") === true && composer && !composer.disabled;
  }, activePane);
  const loaded = await readLongSessionMessageCount(page, sessionKey);
  if (loaded !== messageCount) {
    throw new Error(`Completed run loaded ${loaded} messages; expected ${messageCount}`);
  }
  await frames(page);
}

function geometry(page: Page) {
  return page.locator(threadSelector).evaluate((thread) => ({
    mountedRows: thread.querySelectorAll(".chat-virtual-row").length,
    mountedFragments: thread.querySelectorAll(".chat-group--frame-fragment").length,
    mountedBubbles: thread.querySelectorAll(".chat-bubble").length,
    transcriptElements: thread.querySelectorAll("*").length,
    scrollHeight: thread.scrollHeight,
    clientHeight: thread.clientHeight,
    scrollTop: thread.scrollTop,
  }));
}

async function expand(page: Page) {
  const summary = page.locator(summarySelector);
  await summary.scrollIntoViewIfNeeded();
  if ((await summary.count()) !== 1 || (await summary.getAttribute("aria-expanded")) !== "false") {
    throw new Error("Completed dashboard run must have one collapsed work disclosure");
  }
  await summary.click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("aria-expanded") === "true",
    summarySelector,
  );
  // The paired tool shell has the same entry ID; only the text bubble proves expansion.
  await page.locator(entrySelector(2)).waitFor({ state: "visible" });
  await frames(page);
}

async function scroll(
  page: Page,
  direction: "top" | "bottom",
  messageCount: number,
  geometryProbe: boolean,
) {
  const thread = page.locator(threadSelector);
  const bounds = await thread.boundingBox();
  if (!bounds) {
    throw new Error("Completed-run transcript has no visible scrollport");
  }
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  // Match the original long-session trajectory and native endpoint correction.
  await page.mouse.wheel(0, direction === "top" ? -1 : 1);
  const trajectory = await thread.evaluate(sampleTranscriptScrollFrames, {
    direction,
    trajectory: true,
    count: 61,
    geometry: geometryProbe,
  });
  let endpoint = await thread.evaluate(sampleTranscriptScrollFrames, {
    direction,
    trajectory: false,
    count: 2,
    geometry: geometryProbe,
  });
  let endpointCorrection = false;
  if (endpoint.distancePx > 2) {
    endpointCorrection = true;
    await page.mouse.wheel(
      0,
      (direction === "top" ? -1 : 1) * (endpoint.distancePx + endpoint.clientHeight),
    );
    endpoint = await thread.evaluate(sampleTranscriptScrollFrames, {
      direction,
      trajectory: false,
      count: 2,
      geometry: geometryProbe,
    });
  }
  const frameGaps = trajectory.frames.map((frame) => frame.intervalMs).toSorted((a, b) => a - b);
  const evidence = {
    endpointDistancePx: endpoint.distancePx,
    endpointCorrection,
    ...(geometryProbe
      ? {
          blankFrames: trajectory.frames.filter((frame) => frame.coverage === 0).length,
          minCoverage: Math.min(...trajectory.frames.map((frame) => frame.coverage!)),
        }
      : {}),
    maxMountedRows: Math.max(...trajectory.frames.map((frame) => frame.rows)),
    frameGapsOver50Ms: trajectory.frames.filter((frame) => frame.intervalMs > 50).length,
    frameGapP95Ms: frameGaps[Math.ceil(frameGaps.length * 0.95) - 1]!,
    maxFrameGapMs: Math.max(...trajectory.frames.map((frame) => frame.intervalMs)),
    trajectoryMs: trajectory.completedAtMs - trajectory.startedAtMs,
  };
  if (evidence.blankFrames || evidence.endpointDistancePx > 2) {
    throw new Error(`Completed-run ${direction} geometry failed: ${JSON.stringify(evidence)}`);
  }
  await page
    .locator(entrySelector(direction === "top" ? 1 : messageCount))
    .waitFor({ state: "visible" });
  return Object.fromEntries(
    Object.entries({ ...evidence, ...(await geometry(page)) }).map(([key, value]) => [
      `${direction}${key[0]!.toUpperCase()}${key.slice(1)}`,
      value,
    ]),
  );
}

type WheelFrame = {
  atMs: number;
  sampledAtMs: number;
  intervalMs: number;
  scrollTop: number;
  coverage: number | undefined;
  rows: number;
  settling: boolean;
};
type WheelCapture = {
  frames: WheelFrame[];
  wheelEvents: Array<{ atMs: number; deltaY: number; deltaMode: number; trusted: boolean }>;
  startTop: number;
  endTop: number;
  settled: boolean;
};
type WheelProbe = { finish: () => Promise<WheelCapture>; dispose: () => void };

/** Geometry is optional for timing; rAF observations cannot prove compositor paint. */
function installWheelProbe(
  element: HTMLElement | SVGElement,
  options: { direction: "top" | "bottom"; geometry: boolean },
) {
  const { direction } = options;
  if (!(element instanceof HTMLElement)) {
    throw new Error("Completed-run wheel target is not an HTML scroll element");
  }
  const sampledFrames: WheelFrame[] = [];
  const wheelEvents: WheelCapture["wheelEvents"] = [];
  const startTop = element.scrollTop;
  let previousAt = 0;
  let previousTop = startTop;
  let previousEvents = 0;
  let stableFrames = 0;
  let finishAt: number | undefined;
  let resolve: ((capture: WheelCapture) => void) | undefined;
  let frame = 0;
  const onWheel = (event: WheelEvent) => {
    wheelEvents.push({
      atMs: performance.now(),
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      trusted: event.isTrusted,
    });
  };
  const dispose = () => {
    cancelAnimationFrame(frame);
    element.removeEventListener("wheel", onWheel);
    Reflect.deleteProperty(element, "__completedRunWheelProbe");
  };
  const sample = (atMs: number) => {
    const sampledAtMs = performance.now();
    const top = element.scrollTop;
    if (wheelEvents.length > 0) {
      const rows = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")];
      let coverage: number | undefined;
      if (options.geometry) {
        const viewport = element.getBoundingClientRect();
        // Match the old trajectory's coverage scope; never lay out preparation descendants.
        const segments = rows
          .filter((row) => row.dataset.preparedRow !== "true")
          .map((row) => row.getBoundingClientRect())
          .map(
            (rect) =>
              [Math.max(viewport.top, rect.top), Math.min(viewport.bottom, rect.bottom)] as const,
          )
          .filter(([start, end]) => end > start)
          .toSorted((a, b) => a[0] - b[0]);
        let covered = 0;
        let end = viewport.top;
        for (const [start, bottom] of segments) {
          covered += Math.max(0, bottom - Math.max(start, end));
          end = Math.max(end, bottom);
        }
        coverage = covered / viewport.height;
      }
      sampledFrames.push({
        atMs,
        sampledAtMs,
        intervalMs: atMs - (previousAt || wheelEvents[0]!.atMs),
        scrollTop: top,
        coverage,
        rows: rows.length,
        settling: finishAt !== undefined,
      });
      previousAt = atMs;
    }
    stableFrames =
      top === previousTop && wheelEvents.length === previousEvents ? stableFrames + 1 : 0;
    previousTop = top;
    previousEvents = wheelEvents.length;
    if (finishAt !== undefined && (stableFrames >= 8 || atMs - finishAt >= 2_000)) {
      const capture = {
        frames: sampledFrames,
        wheelEvents,
        startTop,
        endTop: top,
        settled: stableFrames >= 8,
      };
      // Filmstrip consumers can correlate these timestamps/offsets with captured pixels.
      Reflect.set(
        window,
        `__engineCompletedRunWheel${direction === "top" ? "Top" : "Bottom"}`,
        capture,
      );
      dispose();
      resolve!(capture);
      return;
    }
    frame = requestAnimationFrame(sample);
  };
  element.addEventListener("wheel", onWheel, { passive: true });
  Reflect.set(element, "__completedRunWheelProbe", {
    dispose,
    finish: () =>
      new Promise<WheelCapture>((done) => {
        resolve = done;
        stableFrames = 0;
        finishAt = performance.now();
      }),
  } satisfies WheelProbe);
  frame = requestAnimationFrame(sample);
}

async function wheelScroll(page: Page, direction: "top" | "bottom", geometryProbe: boolean) {
  const thread = page.locator(threadSelector);
  const bounds = await thread.boundingBox();
  if (!bounds) {
    throw new Error("Completed-run transcript has no visible scrollport");
  }
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const deltaY =
    (direction === "top" ? -1 : 1) * (await thread.evaluate((el) => el.clientHeight)) * 0.75;
  await thread.evaluate(installWheelProbe, { direction, geometry: geometryProbe });
  const samples = 90;
  const intervalMs = 1_000 / 60;
  const intervals: number[] = [];
  const deliveries: Promise<void>[] = [];
  let delivered = 0;
  let failure: Error | undefined;
  let previousSend = performance.now() - intervalMs;
  const startedAt = performance.now();
  try {
    for (let index = 0; index < samples; index++) {
      let remaining = previousSend + intervalMs - performance.now();
      while (remaining > 0) {
        await new Promise((done) => {
          setTimeout(done, remaining);
        });
        remaining = previousSend + intervalMs - performance.now();
      }
      const atMs = performance.now();
      if (index > 0) {
        intervals.push(atMs - previousSend);
      }
      previousSend = atMs;
      // As in paced gesture input, device cadence does not await renderer acknowledgement.
      deliveries.push(
        page.mouse.wheel(0, deltaY).then(
          () => {
            delivered++;
          },
          (error: unknown) => {
            failure ??= error instanceof Error ? error : new Error(String(error));
          },
        ),
      );
    }
    const inputDurationMs = performance.now() - startedAt;
    await Promise.all(deliveries);
    if (failure) {
      throw failure;
    }
    const deliveryDurationMs = performance.now() - startedAt;
    const capture = await thread.evaluate((element) => {
      // SAFETY: installWheelProbe above owns this per-scrollport diagnostic property.
      const probe = Reflect.get(element, "__completedRunWheelProbe") as WheelProbe;
      return probe.finish();
    });
    const scrollDistancePx = capture.endTop - capture.startTop;
    const trustedEvents = capture.wheelEvents.filter((event) => event.trusted);
    if (!capture.settled || !trustedEvents.length || scrollDistancePx * deltaY <= 0) {
      throw new Error(`Completed-run ${direction} wheel input did not settle after advancing`);
    }
    const firstWheelAtMs = trustedEvents[0]!.atMs;
    const lastWheelAtMs = trustedEvents.at(-1)!.atMs;
    const moved = (entry: WheelFrame, index: number) =>
      entry.scrollTop !== (capture.frames[index - 1]?.scrollTop ?? capture.startTop);
    const firstMovingFrame = capture.frames.findIndex(moved);
    const lastMovingFrame = capture.frames.findLastIndex(moved);
    // Include stalls within the journey, but not stationary input after reaching
    // an edge or the driver acknowledgement/stability tail.
    const activeFrames = capture.frames.slice(firstMovingFrame, lastMovingFrame + 1);
    if (activeFrames.length < 2) {
      throw new Error(
        `Completed-run ${direction} wheel input has too few browser frames to measure`,
      );
    }
    // The first movement can follow a long stall; include its preceding rAF
    // interval when present. The capture's first sample has no such interval.
    const gaps = capture.frames
      .slice(Math.max(1, firstMovingFrame), lastMovingFrame + 1)
      .map((entry) => entry.intervalMs)
      .toSorted((a, b) => a - b);
    const stationaryTail = capture.frames.slice(lastMovingFrame + 1);
    intervals.sort((a, b) => a - b);
    const evidence = {
      requestedInputHz: 60,
      offeredWheelCommands: samples,
      deliveredWheelCommands: delivered,
      deliveredWheelDistancePx: deltaY * delivered,
      observedWheelEvents: capture.wheelEvents.length,
      observedTrustedWheelEvents: trustedEvents.length,
      observedUntrustedWheelEvents: capture.wheelEvents.length - trustedEvents.length,
      observedPixelWheelDistancePx: trustedEvents
        .filter((event) => event.deltaMode === 0)
        .reduce((sum, event) => sum + event.deltaY, 0),
      observedNonPixelWheelEvents: trustedEvents.filter((event) => event.deltaMode !== 0).length,
      inputDurationMs,
      deliveryDurationMs,
      browserWheelSpanMs: lastWheelAtMs - firstWheelAtMs,
      browserFirstInputToMovementMs: activeFrames[0]!.sampledAtMs - firstWheelAtMs,
      browserTrajectoryMs: activeFrames.at(-1)!.atMs - firstWheelAtMs,
      browserMovementStartedAtMs: activeFrames[0]!.atMs - activeFrames[0]!.intervalMs,
      browserMovementEndedAtMs: activeFrames.at(-1)!.atMs,
      browserSettleMs: capture.frames.at(-1)!.atMs - lastWheelAtMs,
      driverIntervalMedianMs: intervals[Math.floor(intervals.length / 2)]!,
      driverIntervalP95Ms: intervals[Math.ceil(intervals.length * 0.95) - 1]!,
      scrollDistancePx,
      startScrollTop: capture.startTop,
      endScrollTop: capture.endTop,
      observedFrames: activeFrames.length,
      ...(geometryProbe
        ? {
            zeroGeometryCoverageFrames: activeFrames.filter((entry) => entry.coverage === 0).length,
            partialGeometryCoverageFrames: activeFrames.filter(
              (entry) => entry.coverage! > 0 && entry.coverage! < 0.99,
            ).length,
            stationaryTailZeroGeometryCoverageFrames: stationaryTail.filter(
              (entry) => entry.coverage === 0,
            ).length,
            stationaryTailPartialGeometryCoverageFrames: stationaryTail.filter(
              (entry) => entry.coverage! > 0 && entry.coverage! < 0.99,
            ).length,
            finalGeometryCoverage: capture.frames.at(-1)!.coverage!,
            minGeometryCoverage: Math.min(...activeFrames.map((entry) => entry.coverage!)),
          }
        : {}),
      stationaryTailFrames: stationaryTail.length,
      maxMountedRows: Math.max(...activeFrames.map((entry) => entry.rows)),
      frameGapsOver50Ms: gaps.filter((gap) => gap > 50).length,
      frameGapP95Ms: gaps[Math.ceil(gaps.length * 0.95) - 1]!,
      maxFrameGapMs: gaps.at(-1)!,
      settled: capture.settled,
    };
    return Object.fromEntries(
      Object.entries(evidence).map(([key, value]) => [
        `${direction}${key[0]!.toUpperCase()}${key.slice(1)}`,
        value,
      ]),
    );
  } finally {
    await thread.evaluate((element) => {
      // SAFETY: This optional property is installed and retired only by this probe.
      const probe = Reflect.get(element, "__completedRunWheelProbe") as WheelProbe | undefined;
      probe?.dispose();
    });
  }
}

/** Same giant-run fixture and scroll protocol as the CDP-only long-session probe. */
export function createEngineCompletedRunScenarios(
  baseUrl: string,
  geometryProbe = true,
): readonly EngineScenario[] {
  return [400, 2_000].flatMap((messageCount) =>
    (["direct-run", "single-run"] as const).flatMap((kind) => {
      const sessionKey = kind === "direct-run" ? directKey : dashboardKey;
      const route = controlUiSessionPath(sessionKey);
      const shared = {
        explicitOnly: true,
        // Mobile WebKit cannot deliver the wheel input used by this trajectory.
        viewports: ["desktop"],
        route,
        initScript: engineProbeInitScript(),
        rowSelector: ".chat-virtual-row",
        fixtureOverrides: (_sandbox, base) => {
          const session = { ...base.sessions[0]!, key: sessionKey };
          const history = createTeamScaleHistoryFixture({
            messageCount,
            inlineWidgets: 0,
            now: 1_800_000_000_000,
            longSessionScenario: kind,
            sessionInfo: session,
            assets: new Map(),
            models: [],
          });
          return {
            sessionKey,
            sessions: [session, ...base.sessions.slice(1)],
            sessionTranscripts: { [sessionKey]: { messages: history.historyMessages } },
          };
        },
      } satisfies Partial<EngineScenario>;
      const id = `completed-${kind}-${messageCount}`;
      const open: EngineScenario = {
        ...shared,
        id: `${id}-open`,
        navigation: "measured",
        expected: `Open the complete ${messageCount}-message ${kind}, with its tail and composer ready.`,
        prepare: async () => {},
        run: async (page) => {
          await page.goto(new URL(route, baseUrl).href, { waitUntil: "domcontentloaded" });
          await ready(page, sessionKey, messageCount);
          return { messageCount, ...(await geometry(page)) };
        },
      };
      const prepare = async (page: Page) => {
        await ready(page, sessionKey, messageCount);
        if (kind === "single-run") {
          await expand(page);
        }
        await page.locator(threadSelector).evaluate((thread) => {
          thread.scrollTop = thread.scrollHeight;
        });
        await page.locator(entrySelector(messageCount)).waitFor({ state: "visible" });
        await frames(page);
      };
      const sweep: EngineScenario = {
        ...shared,
        id: `${id}-scroll`,
        expected: `Scroll the ${messageCount}-message ${kind} to both endpoints${geometryProbe ? " without geometric coverage gaps" : "; row geometry is checked in a separate diagnostic run"}.`,
        prepare,
        run: async (page) => ({
          messageCount,
          ...(await scroll(page, "top", messageCount, geometryProbe)),
          ...(await scroll(page, "bottom", messageCount, geometryProbe)),
          ...(await geometry(page)),
        }),
      };
      return kind === "direct-run"
        ? [
            open,
            sweep,
            {
              ...shared,
              id: `${id}-wheel`,
              expected: `Deliver 90 trusted wheel inputs per direction at 60 Hz through the ${messageCount}-message direct run; report geometric coverage without requiring either endpoint or asserting paint.`,
              prepare,
              run: async (page) => ({
                messageCount,
                ...(await wheelScroll(page, "top", geometryProbe)),
                ...(await wheelScroll(page, "bottom", geometryProbe)),
                ...(await geometry(page)),
              }),
            },
          ]
        : [
            open,
            {
              ...shared,
              id: `${id}-expand`,
              expected: `Expand the completed ${messageCount}-message dashboard run into its fragmented rows.`,
              prepare: (page: Page) => ready(page, sessionKey, messageCount),
              run: async (page: Page) => {
                await expand(page);
                return { messageCount, ...(await geometry(page)) };
              },
            },
            sweep,
          ];
    }),
  );
}
