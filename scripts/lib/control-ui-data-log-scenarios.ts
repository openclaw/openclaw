import type { LogsTailResult } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type {
  InteractionFixtureOverrides,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const tailSize = 500;
const bufferLimit = 2_000;
const file = "/synthetic/gateway.log";
const levels = ["info", "info", "info", "warn", "error"];
const heldTails = new WeakMap<Page, number>();

function createDataLogTail(start: number, length = tailSize): LogsTailResult {
  return {
    file,
    cursor: start + length,
    size: start + length,
    lines: Array.from({ length }, (_, offset) => {
      const index = start + offset;
      return JSON.stringify({
        time: new Date(1_800_000_000_000 + index * 10).toISOString(),
        level: levels[index % levels.length],
        subsystem: `data-lane-${index % 20}`,
        message: `Data log ${String(index).padStart(6, "0")} ${index % 100 === 0 ? "needle" : "routine"}: synthetic structured detail for stream profiling.`,
      });
    }),
  };
}

function createDataLogFixture(): InteractionFixtureOverrides {
  return {
    featureMethods: ["logs.tail"],
    methodResponses: {
      "logs.tail": {
        sequence: [
          ...Array.from({ length: bufferLimit / tailSize }, (_, index) =>
            createDataLogTail(index * tailSize),
          ),
          createDataLogTail(bufferLimit, 0),
        ],
      },
    },
  };
}

async function waitForLine(page: Page, index: number, timeout = 15_000) {
  await page
    .locator(".log-message")
    .getByText(`Data log ${String(index).padStart(6, "0")}`, { exact: false })
    .waitFor({ timeout });
}

async function bufferReady(page: Page) {
  await waitForLine(page, bufferLimit - 1);
  await page.getByRole("switch", { name: "Auto-follow", exact: true }).uncheck();
}

async function holdNextTail(page: Page, gateway: MockGatewayControls) {
  await bufferReady(page);
  // Retained-memory proof must not keep the fixture's consumed raw-tail arrays alive.
  await gateway.setMethodResponse("logs.tail", createDataLogTail(bufferLimit, 0));
  const after = await gateway.deferNext("logs.tail");
  await gateway.waitForRequest("logs.tail", { after });
  heldTails.set(page, bufferLimit);
}

async function atBottom(page: Page) {
  await page.waitForFunction(() => {
    const stream = document.querySelector(".log-stream");
    return stream && stream.scrollHeight - stream.clientHeight - stream.scrollTop < 120;
  });
}

const fixture = { dataPage: "logs", fixtureOverrides: createDataLogFixture };

export const dataLogScenarios: readonly InteractionScenario[] = [
  {
    ...fixture,
    id: "data-logs-first-render",
    route: pathForRoute("config"),
    expected: "Opening Logs reads one 500-line tail and renders its newest entry.",
    prepare: async (page) => {
      await page.locator('.settings-sidebar__item[href="/logs"]').waitFor();
    },
    run: async (page, gateway) => {
      await page.locator('.settings-sidebar__item[href="/logs"]').click();
      await gateway.waitForRequest("logs.tail");
      await waitForLine(page, tailSize - 1);
      return { tailLines: tailSize, bufferLimit };
    },
  },
  {
    ...fixture,
    id: "data-logs-filter",
    route: pathForRoute("logs"),
    expected: "Filtering a full retained log buffer finds the 20 matching messages.",
    prepare: bufferReady,
    run: async (page) => {
      await page.getByRole("textbox", { name: "Filter", exact: true }).fill("needle");
      await page.waitForFunction(() => document.querySelectorAll(".log-row").length === 20);
      await waitForLine(page, 1900);
      return { retainedLines: bufferLimit, matchingLines: 20 };
    },
  },
  {
    ...fixture,
    id: "data-logs-level-filter",
    route: pathForRoute("logs"),
    expected: "Disabling info leaves 800 warning and error rows from the full buffer.",
    prepare: bufferReady,
    run: async (page) => {
      await page.getByRole("checkbox", { name: "info", exact: true }).uncheck();
      await page.waitForFunction(() => document.querySelectorAll(".log-row").length === 800);
      return { retainedLines: bufferLimit, matchingLines: 800 };
    },
  },
  {
    ...fixture,
    id: "data-logs-tail-update",
    route: pathForRoute("logs"),
    expected: "One 500-line live tail evicts the oldest 500 lines and retains at most 2,000 rows.",
    rowSelector: ".log-row",
    prepare: holdNextTail,
    run: async (page, gateway) => {
      const start = heldTails.get(page)!;
      await gateway.resolveDeferred("logs.tail", createDataLogTail(start));
      await waitForLine(page, start + tailSize - 1);
      await page.waitForFunction(() => document.querySelectorAll(".log-row").length === 2000);
      if (
        await page.locator(".log-message").getByText("Data log 000000", { exact: false }).count()
      ) {
        throw new Error("The live log tail retained an evicted line");
      }
      return { deliveredLines: tailSize, retainedLines: bufferLimit };
    },
  },
  {
    ...fixture,
    id: "data-logs-follow-update",
    route: pathForRoute("logs"),
    expected:
      "Auto-follow stays within 120px of the true bottom after the initial buffer and an appended tail.",
    prepare: async (page, gateway) => {
      await waitForLine(page, bufferLimit - 1);
      await atBottom(page);
      const after = await gateway.deferNext("logs.tail");
      await gateway.waitForRequest("logs.tail", { after });
    },
    run: async (page, gateway) => {
      await gateway.resolveDeferred("logs.tail", createDataLogTail(bufferLimit));
      await waitForLine(page, bufferLimit + tailSize - 1);
      await atBottom(page);
      return { retainedLines: bufferLimit, maximumBottomGap: 120 };
    },
  },
  {
    ...fixture,
    id: "data-logs-refresh",
    route: pathForRoute("logs"),
    expected: "Refresh replaces a full buffer with the latest 500-line tail.",
    rowSelector: ".log-row",
    prepare: bufferReady,
    run: async (page, gateway) => {
      await gateway.setMethodResponse("logs.tail", createDataLogTail(10_000));
      const after = (await gateway.getRequests("logs.tail")).length;
      await page
        .locator("openclaw-logs-page")
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await gateway.waitForRequest("logs.tail", { after });
      await waitForLine(page, 10_499);
      await page.waitForFunction(() => document.querySelectorAll(".log-row").length === 500);
      return { retainedLines: tailSize };
    },
  },
  {
    ...fixture,
    id: "data-logs-scroll",
    route: pathForRoute("logs"),
    expected:
      "A scrolled-up stream stays in place after a tail arrives, then scrolls to its newest line.",
    prepare: holdNextTail,
    run: async (page, gateway) => {
      const stream = page.getByRole("region", { name: "Logs", exact: true });
      await stream.hover();
      await page.mouse.wheel(0, -1_000_000);
      await page.waitForFunction(() => document.querySelector(".log-stream")?.scrollTop === 0);
      await gateway.resolveDeferred("logs.tail", createDataLogTail(bufferLimit));
      await waitForLine(page, bufferLimit + tailSize - 1);
      if ((await stream.evaluate((element) => element.scrollTop)) !== 0) {
        throw new Error("A live tail moved the manually scrolled log stream");
      }
      await page.mouse.wheel(0, 1_000_000);
      await page.waitForFunction(() => {
        const element = document.querySelector(".log-stream");
        return element && element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
      });
      return { retainedLines: bufferLimit };
    },
  },
  {
    ...fixture,
    id: "data-logs-long-stream",
    route: pathForRoute("logs"),
    expected:
      "Twenty native 2-second live tails deliver 10,000 lines while retention stays capped at 2,000.",
    prepare: holdNextTail,
    run: async (page, gateway) => {
      const batches = 20;
      await gateway.setMethodResponse("logs.tail", {
        sequence: [
          ...Array.from({ length: batches - 1 }, (_, index) =>
            createDataLogTail(bufferLimit + (index + 1) * tailSize),
          ),
          createDataLogTail(bufferLimit + batches * tailSize, 0),
        ],
      });
      await gateway.resolveDeferred("logs.tail", createDataLogTail(bufferLimit));
      // Native two-second polling is part of this endurance workload.
      await waitForLine(page, bufferLimit + batches * tailSize - 1, 60_000);
      await page.waitForFunction(() => document.querySelectorAll(".log-row").length === 2000);
      await gateway.setMethodResponse(
        "logs.tail",
        createDataLogTail(bufferLimit + batches * tailSize, 0),
      );
      return { deliveredLines: batches * tailSize, retainedLines: bufferLimit, nativePollMs: 2000 };
    },
  },
];
