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

async function scroll(page: Page, direction: "top" | "bottom", messageCount: number) {
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
  });
  let endpoint = await thread.evaluate(sampleTranscriptScrollFrames, {
    direction,
    trajectory: false,
    count: 2,
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
    });
  }
  const frameGaps = trajectory.frames.map((frame) => frame.intervalMs).toSorted((a, b) => a - b);
  const evidence = {
    endpointDistancePx: endpoint.distancePx,
    endpointCorrection,
    blankFrames: trajectory.frames.filter((frame) => frame.coverage === 0).length,
    minCoverage: Math.min(...trajectory.frames.map((frame) => frame.coverage)),
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

/** Same giant-run fixture and scroll protocol as the CDP-only long-session probe. */
export function createEngineCompletedRunScenarios(baseUrl: string): readonly EngineScenario[] {
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
        expected: `Scroll the ${messageCount}-message ${kind} to both endpoints without blank frames.`,
        prepare,
        run: async (page) => ({
          messageCount,
          ...(await scroll(page, "top", messageCount)),
          ...(await scroll(page, "bottom", messageCount)),
          ...(await geometry(page)),
        }),
      };
      return kind === "direct-run"
        ? [open, sweep]
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
