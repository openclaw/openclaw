import type { Page } from "playwright";
import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import { prepareInteractionNavigation } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionFixtureOverrides,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const population = 1_000;
const pageSize = 100;

export function createDataActivityFixture(): InteractionFixtureOverrides {
  const now = Date.now();
  return {
    sessions: Array.from({ length: population }, (_, index) => ({
      key: `agent:main:data-activity-${index}`,
      sessionId: `data-activity-${index}`,
      kind: "direct",
      agentId: "main",
      label: `Data activity ${String(index).padStart(4, "0")}`,
      updatedAt: now - index * 60_000,
      lastActivityAt: now - index * 60_000,
      activitySummary: { state: "current", text: `Synthetic completed investigation ${index}.` },
    })),
  };
}

async function ready(page: Page) {
  await page
    .locator(".activity-feed__session-title")
    .getByText("Data activity 0000", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".activity-feed__session-row").length === 100,
  );
}

const fixture = { dataPage: "activity", fixtureOverrides: createDataActivityFixture };

export const dataActivityScenarios: readonly InteractionScenario[] = [
  {
    ...fixture,
    id: "data-activity-first-render",
    route: pathForRoute("new-session"),
    expected:
      "The Activity route renders its 100-row Gateway window from 1,000 synthetic sessions.",
    prepare: prepareInteractionNavigation,
    run: async (page, gateway) => {
      await page.locator(`.sidebar-pages a[href="${pathForRoute("activity")}"]`).click();
      await gateway.waitForRequest("sessions.list", { match: { source: "activity" } });
      await ready(page);
      return { populationSessions: population, windowRows: pageSize };
    },
  },
  {
    ...fixture,
    id: "data-activity-search",
    route: pathForRoute("activity"),
    expected:
      "Searching Activity requests and shows the one matching session beyond the initial window.",
    prepare: ready,
    run: async (page, gateway) => {
      const after = (
        await gateway.getRequests("sessions.list", {
          source: "activity",
          search: "Data activity 0999",
        })
      ).length;
      await page
        .getByRole("searchbox", { name: "Search session titles…" })
        .fill("Data activity 0999");
      await gateway.waitForRequest("sessions.list", {
        after,
        match: { source: "activity", search: "Data activity 0999" },
      });
      await page
        .locator(".activity-feed__session-title")
        .getByText("Data activity 0999", { exact: true })
        .waitFor();
      return { populationSessions: population, matchingRows: 1 };
    },
  },
  {
    ...fixture,
    id: "data-activity-time-filter",
    route: pathForRoute("activity"),
    expected: "Changing Activity to All time refreshes its bounded 100-row window.",
    prepare: ready,
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("sessions.list", { source: "activity" })).length;
      await page.getByRole("button", { name: "All time", exact: true }).click();
      await gateway.waitForRequest("sessions.list", { after, match: { source: "activity" } });
      await ready(page);
    },
  },
  {
    ...fixture,
    id: "data-activity-live-update",
    route: pathForRoute("activity"),
    expected:
      "A current session receipt updates its visible recap without replacing the 100-row window.",
    rowSelector: ".activity-feed__session-row",
    prepare: ready,
    run: async (page, gateway) => {
      const session = await gateway.getSessionRow("agent:main:data-activity-0");
      const now = Date.now();
      await gateway.emitGatewayEvent("sessions.changed", {
        agentId: "main",
        reason: "patch",
        session: {
          ...session,
          updatedAt: now,
          lastActivityAt: now,
          snapshotAt: now,
          activitySummary: {
            state: "current",
            text: "Synthetic live investigation completed.",
            updatedAt: now,
          },
        },
        ancestorSessions: [],
      });
      await page
        .locator(".activity-feed__recap-text")
        .getByText("Synthetic live investigation completed.", { exact: true })
        .waitFor();
      await ready(page);
      return { populationSessions: population, windowRows: pageSize, updatedRows: 1 };
    },
  },
  {
    ...fixture,
    id: "data-activity-scroll",
    route: pathForRoute("activity"),
    expected: "Scrolling the Activity window reaches its last visible session without adding rows.",
    prepare: ready,
    run: async (page) => {
      await page.locator(".activity-feed__session-row").last().scrollIntoViewIfNeeded();
      await page
        .locator(".activity-feed__session-title")
        .getByText("Data activity 0099", { exact: true })
        .waitFor();
      return {
        populationSessions: population,
        windowRows: await page.locator(".activity-feed__session-row").count(),
      };
    },
  },
];
