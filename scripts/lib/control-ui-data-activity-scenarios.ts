import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import { prepareInteractionNavigation } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionFixtureOverrides,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const population = 1_000;
const pageSize = 100;

function createDataActivityFixture(): InteractionFixtureOverrides {
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

function activityEntryScenario(roundTripMs: 0 | 100): InteractionScenario {
  return {
    ...fixture,
    id: `data-activity-first-render${roundTripMs ? "-100ms" : ""}`,
    route: pathForRoute("new-session"),
    expected: "Activity presents its exact 100-session window from the canonical list owner.",
    rowSelector: ".activity-feed__session-row",
    createRequestHandlers: (defaults) => ({
      "sessions.list": async (params: unknown) => {
        // Preserve the runner's one canonical owner, including sidebar and delta reads.
        const response = await defaults["sessions.list"]!(params);
        if (roundTripMs && isRecord(params) && params.source === "activity") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, roundTripMs);
          });
        }
        return response;
      },
    }),
    prepare: async (page, gateway) => {
      await prepareInteractionNavigation(page);
      if ((await gateway.getRequests("sessions.list", { source: "activity" })).length !== 0) {
        throw new Error("Activity was fetched before first navigation");
      }
    },
    run: async (page, gateway) => {
      await page.locator(`.sidebar-pages a[href="${pathForRoute("activity")}"]`).click();
      await gateway.waitForRequest("sessions.list", { match: { source: "activity" } });
      await page.waitForFunction(() => {
        const rows = Array.from(document.querySelectorAll(".activity-feed__session-row"));
        const byKey = new Map(
          rows.map((row) => [
            row.querySelector("[data-activity-session]")?.getAttribute("data-activity-session"),
            row,
          ]),
        );
        return (
          rows.length === 100 &&
          byKey.size === 100 &&
          Array.from({ length: 100 }, (_, index) => index).every(
            (index) =>
              byKey
                .get(`agent:main:data-activity-${index}`)
                ?.querySelector(".activity-feed__session-title")
                ?.textContent?.trim() === `Data activity ${String(index).padStart(4, "0")}`,
          )
        );
      });
      const requests = await gateway.getRequests("sessions.list", { source: "activity" });
      const params = requests[0]?.params;
      if (requests.length !== 1 || !isRecord(params)) {
        throw new Error("Activity entry did not issue exactly one list request");
      }
      const { activityPulseBoundaries, ...actual } = params;
      const expected = {
        source: "activity",
        excludeDock: true,
        rowMode: "compact",
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: true,
        limit: pageSize,
        includePeople: true,
        excludeSubagents: true,
        includeActivitySummary: true,
        sortBy: "activity",
        activeMinutes: 10080,
        ifRowsRevision: "",
      };
      if (
        Object.keys(actual).length !== Object.keys(expected).length ||
        !Object.entries(expected).every(([key, value]) => actual[key] === value) ||
        !Array.isArray(activityPulseBoundaries) ||
        activityPulseBoundaries.length !== 9
      ) {
        throw new Error("Activity entry changed the default seven-day list contract");
      }
      return {
        populationSessions: population,
        windowRows: pageSize,
        listRequests: requests.length,
        listRoundTripMs: roundTripMs,
      };
    },
  };
}

function activitySearchScenario(roundTripMs: 0 | 100): InteractionScenario {
  const query = "Data activity 0999";
  return {
    ...fixture,
    id: `data-activity-search${roundTripMs ? "-100ms" : ""}`,
    route: pathForRoute("activity"),
    expected: "Searching Activity settles the exact matching session beyond the initial window.",
    createRequestHandlers: (defaults) => ({
      "sessions.list": async (params: unknown) => {
        const response = await defaults["sessions.list"]!(params);
        if (
          roundTripMs &&
          isRecord(params) &&
          params.source === "activity" &&
          params.search === query
        ) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, roundTripMs);
          });
        }
        return response;
      },
    }),
    prepare: ready,
    run: async (page, gateway) => {
      const match = { source: "activity", search: query };
      const before = (await gateway.getRequests("sessions.list", match)).length;
      await page.getByRole("searchbox", { name: "Search session titles…" }).fill(query);
      const request = await gateway.waitForRequest("sessions.list", { after: before, match });
      await page
        .locator(".activity-feed__session-title")
        .getByText(query, { exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll(".activity-feed__session-row");
        return (
          rows.length === 1 &&
          rows[0]
            ?.querySelector("[data-activity-session]")
            ?.getAttribute("data-activity-session") === "agent:main:data-activity-999"
        );
      });
      const requests = (await gateway.getRequests("sessions.list", match)).length - before;
      if (
        requests !== 1 ||
        !isRecord(request.params) ||
        request.params.limit !== pageSize ||
        request.params.rowMode !== "compact" ||
        request.params.activeMinutes !== 10080
      ) {
        throw new Error("Activity search did not settle exactly one default-window query");
      }
      return {
        populationSessions: population,
        matchingRows: 1,
        listRequests: requests,
        searchRoundTripMs: roundTripMs,
      };
    },
  };
}

function activityRecapScenario(roundTripMs: 0 | 100): InteractionScenario {
  return {
    ...fixture,
    id: `data-activity-recap-first-render${roundTripMs ? "-100ms" : ""}`,
    route: pathForRoute("new-session"),
    expected: "The 100 visible stale recaps settle through five 20-session ensure batches.",
    rowSelector: ".activity-feed__session-row",
    fixtureOverrides: () => {
      const data = createDataActivityFixture();
      return {
        ...data,
        featureMethods: ["sessions.activitySummary.ensure"],
        sessions: data.sessions!.map((row, index) =>
          index < pageSize
            ? Object.assign(row, {
                activitySummary: {
                  state: "stale" as const,
                  canEnsure: true,
                  text: `Synthetic previous investigation ${index}.`,
                  updatedAt: 1,
                },
              })
            : row,
        ),
      };
    },
    createRequestHandlers: () => ({
      "sessions.activitySummary.ensure": async (params: unknown) => {
        if (!isRecord(params) || !Array.isArray(params.sessions)) {
          throw new Error("Expected an Activity summary batch");
        }
        if (roundTripMs) {
          // Each actual ensure batch waits once; roster reads and assets remain local.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, roundTripMs);
          });
        }
        return {
          sessions: params.sessions.map((row: unknown) => {
            if (!isRecord(row) || typeof row.key !== "string" || row.agentId !== "main") {
              throw new Error("Unexpected Activity recap session");
            }
            const index = Number(row.key.replace("agent:main:data-activity-", ""));
            if (!Number.isInteger(index) || index < 0 || index >= pageSize) {
              throw new Error("Activity recap is outside the visible fixture window");
            }
            return {
              key: row.key,
              agentId: row.agentId,
              activitySummary: {
                state: "current" as const,
                canEnsure: true,
                text: `Synthetic refreshed investigation ${index}.`,
                updatedAt: Date.now(),
              },
            };
          }),
        };
      },
    }),
    prepare: prepareInteractionNavigation,
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("sessions.activitySummary.ensure")).length;
      await page.locator(`.sidebar-pages a[href="${pathForRoute("activity")}"]`).click();
      await gateway.waitForRequest("sessions.list", { match: { source: "activity" } });
      await ready(page);
      await page.waitForFunction(() => {
        const recaps = document.querySelectorAll(".activity-feed__recap");
        return (
          recaps.length === 100 &&
          Array.from(recaps).every((recap) => {
            const key = recap.getAttribute("data-activity-recap");
            const index = key?.replace("agent:main:data-activity-", "");
            return (
              recap.getAttribute("data-state") === "current" &&
              recap.querySelector(".activity-feed__recap-text")?.textContent ===
                `Synthetic refreshed investigation ${index}.`
            );
          })
        );
      });
      const requests = (await gateway.getRequests("sessions.activitySummary.ensure")).slice(before);
      const keys = requests.flatMap(({ params }) => {
        if (!isRecord(params) || !Array.isArray(params.sessions) || params.sessions.length !== 20) {
          throw new Error("Activity recap did not use 20-session batches");
        }
        return params.sessions.map((row: unknown) => (isRecord(row) ? row.key : undefined));
      });
      if (
        requests.length !== 5 ||
        keys.length !== pageSize ||
        new Set(keys).size !== pageSize ||
        !Array.from({ length: pageSize }, (_, index) =>
          keys.includes(`agent:main:data-activity-${index}`),
        ).every(Boolean)
      ) {
        throw new Error("Activity recap did not settle the exact 100-session window once");
      }
      return {
        populationSessions: population,
        windowRows: pageSize,
        ensuredRecaps: keys.length,
        summaryRequests: requests.length,
        summaryBatchRoundTripMs: roundTripMs,
      };
    },
  };
}

export const dataActivityScenarios: readonly InteractionScenario[] = [
  activityRecapScenario(0),
  activityRecapScenario(100),
  activityEntryScenario(0),
  activityEntryScenario(100),
  activitySearchScenario(0),
  activitySearchScenario(100),
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
