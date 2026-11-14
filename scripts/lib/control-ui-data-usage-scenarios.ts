import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { createEmptyCostUsageTotals } from "../../src/infra/session-cost-usage-totals.js";
import { buildUsageOverview } from "../../src/shared/usage-overview.js";
import type {
  SessionUsageEntry,
  SessionsUsageResult,
  UsageOverviewOptions,
} from "../../src/shared/usage-types.js";
import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import { prepareInteractionNavigation } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionFixtureOverrides,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const sessionCount = 12_000;
const dayCount = 180;
const modelCount = 96;
const query = "Data usage 11999";
const dayMs = 86_400_000;

/** The Gateway owns population filtering and paging; the browser receives at most 50 rows. */
function createDataUsagePopulation(now = Date.now()): SessionUsageEntry[] {
  const end = Date.parse(new Date(now).toISOString().slice(0, 10));
  return Array.from({ length: sessionCount }, (_, index) => {
    const timestamp = end - (index % dayCount) * dayMs + (index % 24) * 3_600_000;
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const provider = index % 2 === 0 ? "openai" : "anthropic";
    const model = `data-model-${index % modelCount}`;
    const totals = {
      ...createEmptyCostUsageTotals(),
      input: 25_000 + index,
      output: 4_000,
      cacheRead: 10_000,
      totalTokens: 39_000 + index,
      totalCost: 0.1 + index / 100_000,
      inputCost: 0.07 + index / 100_000,
      outputCost: 0.03,
    };
    const messages = {
      total: 80,
      user: 20,
      assistant: 20,
      toolCalls: 20,
      toolResults: 20,
      errors: index % 13 === 0 ? 1 : 0,
    };
    return {
      key: `agent:main:data-usage-${index}`,
      label: `Data usage ${String(index).padStart(5, "0")}`,
      agentId: index % 4 === 0 ? "main" : `data-agent-${index % 100}`,
      modelProvider: provider,
      model,
      channel: index % 2 === 0 ? "discord" : "slack",
      updatedAt: timestamp,
      usage: {
        ...totals,
        firstActivity: timestamp,
        lastActivity: timestamp + 300_000,
        durationMs: 300_000,
        activityDates: [date],
        dailyBreakdown: [{ ...totals, date, tokens: totals.totalTokens, cost: totals.totalCost }],
        messageCounts: messages,
        dailyMessageCounts: [{ ...messages, date }],
        modelUsage: [{ provider, model, count: 20, totals }],
        dailyModelUsage: [
          { date, provider, model, count: 20, tokens: totals.totalTokens, cost: totals.totalCost },
        ],
        toolUsage: {
          totalCalls: 20,
          uniqueTools: 1,
          tools: [{ name: `data_tool_${index % 80}`, count: 20 }],
        },
      },
    };
  });
}

function overviewOptions(raw: Record<string, unknown>): UsageOverviewOptions {
  const sort = raw.sort;
  return {
    limit: 50,
    offset: typeof raw.offset === "number" ? raw.offset : 0,
    query: typeof raw.query === "string" ? raw.query : undefined,
    sort:
      sort === "cost" || sort === "errors" || sort === "messages" || sort === "recent"
        ? sort
        : "tokens",
    sortDirection: raw.sortDirection === "asc" ? "asc" : "desc",
    selectedDays: Array.isArray(raw.selectedDays)
      ? raw.selectedDays.filter((day): day is string => typeof day === "string")
      : undefined,
    selectedHours: Array.isArray(raw.selectedHours)
      ? raw.selectedHours.filter((hour): hour is number => typeof hour === "number")
      : undefined,
    selectedSessions: Array.isArray(raw.selectedSessions)
      ? raw.selectedSessions.filter((key): key is string => typeof key === "string")
      : undefined,
  };
}

function createDataUsageHandler() {
  const rows = createDataUsagePopulation();
  return (raw: unknown): SessionsUsageResult => {
    if (!isRecord(raw)) {
      throw new Error("Expected sessions.usage parameters");
    }
    const start = typeof raw.startDate === "string" ? Date.parse(raw.startDate) : 0;
    const end = typeof raw.endDate === "string" ? Date.parse(raw.endDate) + dayMs : Infinity;
    const projection = buildUsageOverview({
      rows: rows.filter((row) => row.updatedAt! >= start && row.updatedAt! < end),
      options: overviewOptions(raw),
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    return {
      ...projection,
      updatedAt: Date.now(),
      startDate: typeof raw.startDate === "string" ? raw.startDate : "1970-01-01",
      endDate:
        typeof raw.endDate === "string" ? raw.endDate : new Date().toISOString().slice(0, 10),
      cacheStatus: { status: "fresh", cachedFiles: sessionCount, pendingFiles: 0, staleFiles: 0 },
    };
  };
}

function createDataUsageFixture(): InteractionFixtureOverrides {
  return { featureMethods: ["sessions.usage", "usage.status"] };
}

async function ready(page: Page) {
  await page.locator(".usage-page .session-bar-row").first().waitFor();
  await page.locator(".usage-page .usage-query-input").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>('.usage-page button[aria-label="Refresh"]')
        ?.disabled === false,
  );
}

async function months(page: Page) {
  await ready(page);
  const now = Date.now();
  const start = new Date(now - (dayCount - 1) * dayMs).toISOString().slice(0, 10);
  const end = new Date(now).toISOString().slice(0, 10);
  const dates = page.locator(".usage-date-range input");
  // The fixture uses UTC days; the page's default end date uses the browser's local day.
  await dates.last().fill(end);
  await dates.last().press("Tab");
  await dates.first().fill(start);
  await dates.first().press("Tab");
  await page
    .locator(".usage-query-count")
    .getByText(/12[,.]?000/)
    .waitFor();
}

const fixture = {
  dataPage: "usage",
  fixtureOverrides: createDataUsageFixture,
  // Per scenario state is installed by the runner, keeping all query work outside Chromium.
  createRequestHandlers: () => ({ "sessions.usage": createDataUsageHandler() }),
};

const usageScenarios: readonly InteractionScenario[] = [
  {
    ...fixture,
    id: "data-usage-first-render",
    route: pathForRoute("new-session"),
    expected:
      "The 12,000-session usage population renders its bounded first page for the default range.",
    prepare: prepareInteractionNavigation,
    run: async (page, gateway) => {
      await page.locator(`.sidebar-pages a[href="${pathForRoute("usage")}"]`).click();
      await gateway.waitForRequest("sessions.usage");
      await ready(page);
      return {
        populationSessions: sessionCount,
        calendarDays: dayCount,
        models: modelCount,
        maxPageRows: 50,
      };
    },
  },
  {
    ...fixture,
    id: "data-usage-date-range",
    route: pathForRoute("usage"),
    expected: "Expanding the date range includes all 12,000 sessions across 180 days.",
    prepare: ready,
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("sessions.usage")).length;
      await months(page);
      await gateway.waitForRequest("sessions.usage", { after });
      return { populationSessions: sessionCount, calendarDays: dayCount, models: modelCount };
    },
  },
  {
    ...fixture,
    id: "data-usage-model-filter",
    route: pathForRoute("usage"),
    expected: "The model filter selects one of 96 models and shows its 125 matching sessions.",
    prepare: months,
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("sessions.usage")).length;
      await page.locator('[id="usage-filter-model:trigger"]').click();
      await page
        .locator('[id="usage-filter-model:content"] [data-value="option:data-model-0"]')
        .click();
      await gateway.waitForRequest("sessions.usage", { after });
      await page.locator('[id="usage-filter-model:trigger"]').click();
      await page.locator(".usage-query-count").getByText(/125/).waitFor();
      return { models: modelCount, matchingSessions: sessionCount / modelCount };
    },
  },
  {
    ...fixture,
    id: "data-usage-search",
    route: pathForRoute("usage"),
    expected: "Applying a query returns the one matching session from 12,000 rows.",
    prepare: months,
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("sessions.usage", { query })).length;
      await page.locator(".usage-query-input").fill(query);
      await page.locator(".usage-query-input").press("Enter");
      await gateway.waitForRequest("sessions.usage", { after, match: { query } });
      await page.locator(".session-bar-title").getByText(query, { exact: true }).waitFor();
      return { populationSessions: sessionCount, matchingSessions: 1 };
    },
  },
  {
    ...fixture,
    id: "data-usage-sort",
    route: pathForRoute("usage"),
    expected:
      "Changing session order requests one bounded page from the Gateway and shows the recent sort.",
    prepare: months,
    run: async (page, gateway) => {
      const firstTitle = await page.locator(".session-bar-title").first().textContent();
      const after = (await gateway.getRequests("sessions.usage", { sort: "recent" })).length;
      await page.locator(".sessions-sort select").selectOption("recent");
      await gateway.waitForRequest("sessions.usage", { after, match: { sort: "recent" } });
      await page.waitForFunction(
        (previous) => document.querySelector(".session-bar-title")?.textContent !== previous,
        firstTitle,
      );
      await ready(page);
    },
  },
  {
    ...fixture,
    id: "data-usage-refresh",
    route: pathForRoute("usage"),
    expected: "Refreshing months of usage preserves the bounded session rows and chart series.",
    rowSelector: ".session-bar-row",
    prepare: months,
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("sessions.usage")).length;
      await page
        .locator(".usage-page")
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await gateway.waitForRequest("sessions.usage", { after });
      await ready(page);
    },
  },
  {
    ...fixture,
    id: "data-usage-scroll",
    route: pathForRoute("usage"),
    expected: "Scrolling the usage page reveals the session table without growing its 50-row page.",
    prepare: months,
    run: async (page) => {
      await page.locator(".sessions-card").scrollIntoViewIfNeeded();
      await page.locator(".session-bar-row").first().waitFor({ state: "visible" });
      return {
        populationSessions: sessionCount,
        mountedRows: await page.locator(".session-bar-row").count(),
      };
    },
  },
];

function usageRoundTripScenario(
  scenario: InteractionScenario,
  roundTripMs: 0 | 100,
): InteractionScenario {
  return {
    ...scenario,
    id: `${scenario.id}${roundTripMs ? "-100ms" : ""}`,
    createRequestHandlers: () => {
      const read = createDataUsageHandler();
      return {
        "sessions.usage": roundTripMs
          ? async (params: unknown) => {
              // Delay this RPC response, not assets, status reads, or browser timers.
              await new Promise<void>((resolve) => {
                setTimeout(resolve, roundTripMs);
              });
              return read(params);
            }
          : read,
      };
    },
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("sessions.usage")).length;
      const evidence = await scenario.run(page, gateway);
      await ready(page);
      const requests = (await gateway.getRequests("sessions.usage")).length - before;
      if (requests === 0) {
        throw new Error(`Usage action ${scenario.id} completed without a sessions.usage request`);
      }
      return { ...evidence, usageRequests: requests, usageRoundTripMs: roundTripMs };
    },
  };
}

export const dataUsageScenarios: readonly InteractionScenario[] = usageScenarios.flatMap(
  (scenario) =>
    scenario.id === "data-usage-scroll"
      ? [scenario]
      : [usageRoundTripScenario(scenario, 0), usageRoundTripScenario(scenario, 100)],
);
