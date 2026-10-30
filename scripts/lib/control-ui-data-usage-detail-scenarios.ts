import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { createEmptyCostUsageTotals } from "../../src/infra/session-cost-usage-totals.js";
import type { SessionLogEntry } from "../../src/infra/session-cost-usage.types.js";
import type { SessionUsageTimeSeries } from "../../src/shared/session-usage-timeseries-types.js";
import { buildUsageOverview } from "../../src/shared/usage-overview.js";
import type { SessionUsageEntry, SessionsUsageResult } from "../../src/shared/usage-types.js";
import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionEvidence,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const targetKey = "agent:main:data-usage-detail";
const targetLabel = "Data usage detail";
const pointCount = 200;
const logCount = 1_000;
const panel = ".session-detail-panel";
const chart = `${panel} .session-timeseries-compact`;
const logs = `${panel} .session-logs-compact`;
const detailMethods = ["sessions.usage", "sessions.usage.timeseries", "sessions.usage.logs"];

function createDetailHandlers(roundTripMs: 0 | 100) {
  // Yesterday is inside the default local 30-day range on either side of UTC midnight.
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T09:00:00Z`);
  const series: SessionUsageTimeSeries = {
    sessionId: "data-usage-detail-session",
    points: Array.from({ length: pointCount }, (_, index) => ({
      timestamp: start + index * 60_000,
      input: 320,
      output: 96,
      cacheRead: 80,
      cacheWrite: 16,
      totalTokens: 512,
      cost: 0.01,
      cumulativeTokens: (index + 1) * 512,
      cumulativeCost: (index + 1) / 100,
    })),
  };
  const roles: SessionLogEntry["role"][] = ["user", "assistant", "assistant", "toolResult", "tool"];
  const contentBody = "Synthetic detail content with no private data.\n".repeat(32);
  const logEntries: SessionLogEntry[] = Array.from({ length: logCount }, (_, index) => {
    const block = Math.floor(index / 5);
    const slot = index % 5;
    const tool = `detail_tool_${String(block % 50).padStart(2, "0")}`;
    const content = [
      `detail-log-${String(index).padStart(4, "0")}`,
      ...(slot === 0 && block % 10 === 0 ? ["detail-sentinel"] : []),
      ...(slot >= 2 ? [`[Tool: ${tool}]`] : []),
      ...(slot >= 3 ? ["[Tool Result]"] : []),
      contentBody,
    ].join("\n");
    return {
      timestamp: start + block * 60_000,
      role: roles[slot]!,
      content,
      ...(slot === 2 ? { tokens: 512, cost: 0.01 } : {}),
    };
  });
  const rows: SessionUsageEntry[] = Array.from({ length: 50 }, (_, index) => {
    const count = index === 0 ? pointCount : 1;
    const totals = {
      ...createEmptyCostUsageTotals(),
      input: count * 320,
      output: count * 96,
      cacheRead: count * 80,
      cacheWrite: count * 16,
      totalTokens: count * 512,
      totalCost: count / 100,
      inputCost: count * 0.006,
      outputCost: count * 0.002,
      cacheReadCost: count * 0.0015,
      cacheWriteCost: count * 0.0005,
    };
    return {
      key: index === 0 ? targetKey : `agent:main:data-usage-context-${index}`,
      label: index === 0 ? targetLabel : `Data usage context ${index}`,
      sessionId: index === 0 ? series.sessionId : `data-usage-context-session-${index}`,
      agentId: "main",
      modelProvider: "openai",
      model: "data-detail-model",
      updatedAt: start + (count - 1) * 60_000,
      usage: {
        ...totals,
        firstActivity: start,
        lastActivity: start + (count - 1) * 60_000,
        durationMs: (count - 1) * 60_000,
        activityDates: [day],
        dailyBreakdown: [
          { ...totals, date: day, tokens: totals.totalTokens, cost: totals.totalCost },
        ],
        messageCounts: {
          total: count * 5,
          user: count,
          assistant: count * 2,
          toolCalls: count,
          toolResults: count * 2,
          errors: 0,
        },
        toolUsage: {
          totalCalls: count,
          uniqueTools: index === 0 ? 50 : 1,
          tools: Array.from({ length: index === 0 ? 50 : 1 }, (_toolEntry, tool) => ({
            name: `detail_tool_${String(tool).padStart(2, "0")}`,
            count: index === 0 ? 4 : 1,
          })),
        },
      },
    };
  });
  async function delayDetail() {
    if (roundTripMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, roundTripMs);
      });
    }
  }
  function target(params: unknown) {
    if (!isRecord(params) || params.key !== targetKey) {
      throw new Error("Expected the selected Usage detail session");
    }
    return params;
  }
  return {
    "sessions.usage": async (params: unknown): Promise<SessionsUsageResult> => {
      if (
        !isRecord(params) ||
        typeof params.startDate !== "string" ||
        typeof params.endDate !== "string"
      ) {
        throw new Error("Expected dated Usage parameters");
      }
      const keyed = params.key !== undefined;
      if (keyed) {
        target(params);
        await delayDetail();
      }
      const selectedSessions = Array.isArray(params.selectedSessions)
        ? params.selectedSessions.filter((key): key is string => typeof key === "string")
        : undefined;
      const projection = buildUsageOverview({
        rows: keyed ? rows.filter((row) => row.key === targetKey) : rows,
        options: {
          limit: keyed ? 1 : 50,
          query: typeof params.query === "string" ? params.query : undefined,
          selectedSessions,
          sort: "cost",
          sortDirection: "desc",
        },
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
      });
      return {
        ...projection,
        updatedAt: start,
        startDate: params.startDate,
        endDate: params.endDate,
        cacheStatus: { status: "fresh", cachedFiles: rows.length, pendingFiles: 0, staleFiles: 0 },
      };
    },
    "sessions.usage.timeseries": async (params: unknown): Promise<SessionUsageTimeSeries> => {
      target(params);
      await delayDetail();
      return series;
    },
    "sessions.usage.logs": async (params: unknown): Promise<{ logs: SessionLogEntry[] }> => {
      const request = target(params);
      if (request.limit !== logCount) {
        throw new Error("Expected the native Usage log limit of 1,000");
      }
      await delayDetail();
      return { logs: logEntries };
    },
  };
}

async function textIncludes(page: Page, selector: string, text: string) {
  await page.waitForFunction(
    ({ selector: elementSelector, text: expectedText }) =>
      document.querySelector(elementSelector)?.textContent?.includes(expectedText),
    { selector, text },
  );
}

async function headerCount(page: Page, count: number, filtered = true) {
  await textIncludes(
    page,
    `${logs} .session-logs-header-count`,
    filtered ? `(${count} of ${logCount}` : `(${logCount} messages)`,
  );
}

async function prepareRow(page: Page) {
  const button = page.getByRole("button", { name: targetLabel, exact: true });
  await button.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>('.usage-page button[aria-label="Refresh"]')
        ?.disabled === false,
  );
  await button.scrollIntoViewIfNeeded();
  await frames(page);
}

async function detailRequestCount(gateway: MockGatewayControls) {
  const counts = await Promise.all(
    detailMethods.map((method) => gateway.getRequests(method, { key: targetKey })),
  );
  return counts.reduce((sum, requests) => sum + requests.length, 0);
}

async function openDetail(page: Page, gateway: MockGatewayControls) {
  const counts = await Promise.all(
    detailMethods.map((method) => gateway.getRequests(method, { key: targetKey })),
  );
  await page.getByRole("button", { name: targetLabel, exact: true }).click();
  await Promise.all(
    detailMethods.map((method, index) =>
      gateway.waitForRequest(method, { match: { key: targetKey }, after: counts[index]!.length }),
    ),
  );
  await page.locator(panel).waitFor();
  await textIncludes(page, `${panel} .session-detail-title`, targetLabel);
  await textIncludes(page, `${chart} .timeseries-summary`, "200");
  await textIncludes(page, `${panel} .session-detail-stats`, "102.4K");
  await headerCount(page, logCount, false);
  await textIncludes(page, `${panel} .context-details-panel`, "No context data");
  await page
    .getByRole("button", { name: targetLabel, exact: true })
    .getAttribute("aria-pressed")
    .then((value) => {
      if (value !== "true") {
        throw new Error("Native session selection was not retained");
      }
    });
  await page.locator(panel).scrollIntoViewIfNeeded();
  await frames(page);
}

async function evidence(page: Page): Promise<InteractionEvidence> {
  return page.evaluate(
    ({
      panel: panelSelector,
      chart: chartSelector,
      logs: logsSelector,
      pointCount: fixturePointCount,
      logCount: fixtureLogCount,
    }) => ({
      suppliedPoints: fixturePointCount,
      suppliedLogs: fixtureLogCount,
      mountedLogRows: document.querySelectorAll(`${logsSelector} .session-log-entry`).length,
      mountedChartSegments: document.querySelectorAll(`${chartSelector} .ts-bar`).length,
      toolFilterOptions: document.querySelectorAll(
        `${logsSelector} select[aria-label="Filter by tool"] option`,
      ).length,
      mountedToolDisclosures: document.querySelectorAll(`${logsSelector} .session-log-tools`)
        .length,
      expandedToolDisclosures: document.querySelectorAll(`${logsSelector} .session-log-tools[open]`)
        .length,
      detailPanels: document.querySelectorAll(panelSelector).length,
    }),
    { panel, chart, logs, pointCount, logCount },
  );
}

function openScenario(roundTripMs: 0 | 100): InteractionScenario {
  return {
    id: roundTripMs ? "data-usage-detail-open-100ms" : "data-usage-detail-open",
    dataPage: "usage",
    route: pathForRoute("usage"),
    expected:
      "Native session selection loads its summary, 200 chart points and 1,000 bounded log entries.",
    fixtureOverrides: () => ({ featureMethods: [...detailMethods, "usage.status"] }),
    createRequestHandlers: () => createDetailHandlers(roundTripMs),
    rowSelector: `${logs} .session-log-entry`,
    prepare: prepareRow,
    run: async (page, gateway) => {
      const before = await detailRequestCount(gateway);
      await openDetail(page, gateway);
      return {
        ...(await evidence(page)),
        detailRpcCount: (await detailRequestCount(gateway)) - before,
        detailRoundTripMs: roundTripMs,
      };
    },
  };
}

function localScenario(
  id: string,
  expected: string,
  run: (page: Page) => Promise<void>,
  prepare?: (page: Page) => Promise<void>,
): InteractionScenario {
  return {
    ...openScenario(0),
    id,
    expected,
    prepare: async (page, gateway) => {
      await prepareRow(page);
      await openDetail(page, gateway);
      await prepare?.(page);
      await frames(page);
    },
    run: async (page, gateway) => {
      const before = await detailRequestCount(gateway);
      await run(page);
      await frames(page);
      const requests = (await detailRequestCount(gateway)) - before;
      if (requests !== 0) {
        throw new Error("A local detail presentation action re-fetched Usage details");
      }
      return { ...(await evidence(page)), detailRpcCount: requests };
    },
  };
}

const expandAllLogsScenario = localScenario(
  "data-usage-detail-log-expand",
  "Expand All opens the mounted tool disclosures without re-reading the conversation.",
  async (page) => {
    await page
      .locator(`${logs} .session-logs-header`)
      .getByRole("button", { name: "Expand All", exact: true })
      .click();
    await page
      .locator(`${logs} .session-logs-header`)
      .getByRole("button", { name: "Collapse All", exact: true })
      .waitFor();
    await page.waitForFunction(
      ({ logs: logsSelector }) =>
        document.querySelectorAll(`${logsSelector} .session-log-tools[open]`).length > 0 &&
        document.querySelectorAll(`${logsSelector} .session-log-tools:not([open])`).length === 0,
      { logs },
    );
    await headerCount(page, logCount, false);
  },
);

export const dataUsageDetailScenarios: readonly InteractionScenario[] = [
  openScenario(0),
  openScenario(100),
  localScenario(
    "data-usage-detail-mode",
    "Cumulative mode shows 102.4K tokens at the last point and removes the per-type breakdown.",
    async (page) => {
      await page.locator(chart).getByRole("button", { name: "Cumulative", exact: true }).click();
      await page.waitForFunction(
        ({ chart: chartSelector }) => {
          const bars = document.querySelectorAll(`${chartSelector} .ts-bar`);
          return (
            bars[bars.length - 1]?.getAttribute("aria-label")?.includes("102.4K tokens") &&
            !document.querySelector(`${chartSelector} .timeseries-breakdown`)
          );
        },
        { chart },
      );
    },
  ),
  localScenario(
    "data-usage-detail-breakdown",
    "By Type restores all four nonzero token categories at every point.",
    async (page) => {
      await page.locator(chart).getByRole("button", { name: "By Type", exact: true }).click();
      await page.locator(`${chart} .timeseries-breakdown`).waitFor();
      await page.waitForFunction(
        ({ chart: chartSelector }) => {
          const label =
            document.querySelector(`${chartSelector} .ts-bar`)?.getAttribute("aria-label") ?? "";
          return ["Out 96", "In 320", "CW 16", "CR 80"].every((part) => label.includes(part));
        },
        { chart },
      );
    },
    async (page) => {
      await page.locator(chart).getByRole("button", { name: "Total", exact: true }).click();
      await page.locator(`${chart} .timeseries-breakdown`).waitFor({ state: "detached" });
    },
  ),
  localScenario(
    "data-usage-detail-range",
    "Moving Range start to End selects one point, 512 tokens and exactly its five log entries.",
    async (page) => {
      await page
        .locator(chart)
        .getByRole("slider", { name: "Range start", exact: true })
        .press("End");
      await textIncludes(page, `${chart} .timeseries-summary__range`, "Turns 200–200 of 200");
      await textIncludes(page, `${panel} .session-detail-stats`, "512");
      await headerCount(page, 5);
      await textIncludes(page, `${logs} .session-log-content`, "detail-log-0995");
      await page.locator(chart).getByRole("button", { name: "Reset", exact: true }).waitFor();
    },
  ),
  localScenario(
    "data-usage-detail-log-search",
    "Searching the loaded conversation keeps its 20 sentinel user messages.",
    async (page) => {
      await page
        .locator(logs)
        .getByRole("textbox", { name: "Search conversation", exact: true })
        .fill("detail-sentinel");
      await headerCount(page, 20);
      await textIncludes(page, `${logs} .session-log-content`, "detail-log-0000");
    },
  ),
  localScenario(
    "data-usage-detail-log-role",
    "The native User role filter retains exactly 200 messages.",
    async (page) => {
      await page
        .locator(logs)
        .getByRole("listbox", { name: "Filter by role", exact: true })
        .selectOption("user");
      await headerCount(page, 200);
      await textIncludes(page, `${logs} .session-log-role`, "You");
    },
  ),
  localScenario(
    "data-usage-detail-log-tool",
    "Filtering the 50-name tool inventory retains its selected tool's 12 call/result rows.",
    async (page) => {
      await page
        .locator(logs)
        .getByRole("listbox", { name: "Filter by tool", exact: true })
        .selectOption("detail_tool_49");
      await headerCount(page, 12);
      await textIncludes(page, `${logs} .session-log-content`, "detail-log-0247");
      await textIncludes(page, `${logs} .session-log-tools summary`, "detail_tool_49");
    },
  ),
  localScenario(
    "data-usage-detail-log-has-tools",
    "Has tools keeps exactly the 600 tool-bearing messages.",
    async (page) => {
      await page.locator(logs).getByRole("checkbox", { name: "Has tools", exact: true }).check();
      await headerCount(page, 600);
      await textIncludes(page, `${logs} .session-log-content`, "detail-log-0002");
    },
  ),
  expandAllLogsScenario,
  {
    ...expandAllLogsScenario,
    id: "data-usage-detail-log-expand-identity",
    expected:
      "Expand All preserves chart geometry and data while reporting rectangle and log row reuse.",
    diagnostic:
      "Chart identity observation and snapshot comparison; exclude from timing comparisons.",
    run: async (page, gateway) => {
      const probe = await page.evaluateHandle((chartSelector) => {
        const selector = `${chartSelector} .timeseries-svg rect`;
        const original = [...document.querySelectorAll(selector)];
        if (original.length === 0) {
          throw new Error("Expected the loaded Usage chart before expanding logs");
        }
        const snapshot = () =>
          JSON.stringify({
            viewBoxes: [...document.querySelectorAll(`${chartSelector} .timeseries-svg`)].map(
              (element) => element.getAttribute("viewBox"),
            ),
            rectangles: [...document.querySelectorAll(selector)].map((element) =>
              [...element.attributes]
                .map(({ name, value }) => ({ name, value }))
                .toSorted((left, right) => left.name.localeCompare(right.name)),
            ),
            labels: [
              ...document.querySelectorAll(
                `${chartSelector} .ts-axis-label, ${chartSelector} .timeseries-summary`,
              ),
            ].map((element) => element.textContent),
          });
        const before = snapshot();
        const seen = new WeakSet(original);
        const state = { created: 0 };
        const count = (records: MutationRecord[]) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) {
                continue;
              }
              const rectangles = [...node.querySelectorAll(selector)];
              if (node.matches(selector)) {
                rectangles.push(node);
              }
              for (const rectangle of rectangles) {
                if (!seen.has(rectangle)) {
                  seen.add(rectangle);
                  state.created++;
                }
              }
            }
          }
        };
        const observer = new MutationObserver(count);
        observer.observe(document.body, { childList: true, subtree: true });
        return { selector, original, snapshot, before, state, count, observer };
      }, chart);
      try {
        const logEvidence = await expandAllLogsScenario.run(page, gateway);
        const chartEvidence = await probe.evaluate((value) => {
          value.count(value.observer.takeRecords());
          value.observer.disconnect();
          if (value.snapshot() !== value.before) {
            throw new Error("Expanding logs changed Usage chart geometry or data");
          }
          const current = new Set(document.querySelectorAll(value.selector));
          return {
            chartRectsInitial: value.original.length,
            chartRectsCreated: value.state.created,
            chartRectsRetained: value.original.filter((rectangle) => current.has(rectangle)).length,
            chartRectsFinal: current.size,
            chartGeometryAndDataUnchanged: true,
          };
        });
        return { ...logEvidence, ...chartEvidence };
      } finally {
        try {
          await probe.evaluate((value) => value.observer.disconnect());
        } finally {
          await probe.dispose();
        }
      }
    },
  },
  localScenario(
    "data-usage-detail-log-scroll",
    "The last of the 1,000 log entries remains reachable within the page scroller.",
    async (page) => {
      const last = page
        .locator(`${logs} .session-log-content`)
        .filter({ hasText: "detail-log-0999" });
      await last.waitFor();
      await last.scrollIntoViewIfNeeded();
      if (!(await last.isVisible())) {
        throw new Error("The final Usage log entry is not visible");
      }
      await headerCount(page, logCount, false);
    },
  ),
];
