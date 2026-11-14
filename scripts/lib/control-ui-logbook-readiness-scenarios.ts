import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { logbookStatus, logbookTimeline } from "../../ui/src/pages/plugin/logbook.test-support.ts";
import { waitForControlUiRoute } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import type { InteractionScenario } from "./control-ui-interaction-scenarios.ts";
import { readRendererProcessSnapshot } from "./control-ui-renderer-metrics.ts";

const today = new Date().toISOString().slice(0, 10);
const previousDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const statusMarker = "Settled capture host";
const card = (day: string, title: string) =>
  logbookTimeline(day, [
    { title, startMs: Date.parse(`${day}T16:30:00Z`), endMs: Date.parse(`${day}T17:30:00Z`) },
  ]);

async function openLogbook(page: Page) {
  await page.evaluate(() =>
    window.openclawControlUi!.navigate("plugin", { search: "?plugin=logbook&id=logbook" }),
  );
}

// The interaction harness owns production HTTP delivery, synthetic WebSocket
// responses, AB/control ordering, browser custody, and CPU/trace collection.
export const logbookReadinessScenarios: InteractionScenario[] = [false, true].flatMap(
  (historical) =>
    [false, true].map((sampleRss) => ({
      id:
        (historical ? "data-logbook-previous-250ms" : "data-logbook-first-content-250ms") +
        (sampleRss ? "-rss" : ""),
      diagnostic: sampleRss
        ? "RSS polling; exclude its latency and CPU from performance comparisons."
        : undefined,
      route: "/new",
      dataPage: "logbook",
      explicitOnly: true,
      observationBrowser: true,
      rowSelector: ".logbook-card",
      expected:
        "The selected card uses the capture timezone and fresh status settles without duplicate reads.",
      setup: async (page) => {
        const session = await page.context().newCDPSession(page);
        // Detaching resets the override. The observation-owned browser closes
        // this session with the page after all measured requests settle.
        await session.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
      },
      fixtureOverrides: () => ({
        sessions: [],
        communityInvite: false,
        automaticallyFetchFavicons: false,
        controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
        featureMethods: ["logbook.status", "logbook.timeline"],
        methodResponses: {
          "logbook.status": logbookStatus(today, { nodeName: "Initial capture host" }),
          "logbook.timeline": card(today, "Current card"),
        },
      }),
      prepare: async (page, gateway) => {
        const timeZone = await page.evaluate(
          () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        if (timeZone !== "UTC") {
          throw new Error(`Expected UTC fixture timezone, got ${timeZone}`);
        }
        if (historical) {
          await openLogbook(page);
          await page.getByText("Current card", { exact: true }).waitFor();
          await page.getByText("Initial capture host", { exact: true }).waitFor();
          await waitForControlUiRoute(page, { routeId: "plugin" });
          await gateway.setMethodResponse("logbook.timeline", card(previousDay, "Historical card"));
        }
        await gateway.setMethodResponse(
          "logbook.status",
          logbookStatus(today, { nodeName: statusMarker }),
        );
        await gateway.setMethodDelay("logbook.status", 250);
        await frames(page);
      },
      run: async (page, gateway) => {
        const browser = page.context().browser();
        if (!browser) {
          throw new Error("Readiness measurement requires its owned Chromium browser");
        }
        const session = sampleRss ? await browser.newBrowserCDPSession() : null;
        const lifetime = new AbortController();
        let sampledPeakRendererRssBytes = 0;
        let rssSamples = 0;
        // Sample only the validated renderer PIDs. This diagnostic is a sampled
        // process sum, not a true allocation peak or a retained-memory/leak test.
        const sampling = (async () => {
          if (!session) {
            return;
          }
          try {
            while (!lifetime.signal.aborted) {
              const rows = await readRendererProcessSnapshot(session);
              sampledPeakRendererRssBytes = Math.max(
                sampledPeakRendererRssBytes,
                rows.reduce((sum, row) => sum + row.rssBytes, 0),
              );
              rssSamples++;
              await delay(25, undefined, { signal: lifetime.signal });
            }
          } catch (error) {
            if (!(error instanceof Error && error.name === "AbortError")) {
              throw error;
            }
          }
        })();
        void sampling.catch(() => undefined);
        try {
          const statusBefore = (await gateway.getRequests("logbook.status")).length;
          const timelineBefore = (await gateway.getRequests("logbook.timeline")).length;
          const started = await page.evaluate(() => performance.now());
          // Start status observation at the same boundary in both variants;
          // serial locator polling after the card would bias settlement latency.
          const settledStatus = page.getByText(statusMarker, { exact: true }).waitFor();
          void settledStatus.catch(() => undefined);
          if (historical) {
            await page.getByRole("button", { name: "Previous day", exact: true }).click();
          } else {
            await openLogbook(page);
          }
          await page
            .getByText(historical ? "Historical card" : "Current card", { exact: true })
            .waitFor();
          const firstContentMs = await page.evaluate((start) => performance.now() - start, started);
          if (!(await page.locator(".logbook-card__time").textContent())?.includes("04:30 PM")) {
            throw new Error("Timeline did not preserve the capture timezone");
          }
          await settledStatus;
          await waitForControlUiRoute(page, { routeId: "plugin" });
          await frames(page);
          const fullSettlementMs = await page.evaluate(
            (start) => performance.now() - start,
            started,
          );
          const statusRequests =
            (await gateway.getRequests("logbook.status")).length - statusBefore;
          const timelineRequests =
            (await gateway.getRequests("logbook.timeline")).length - timelineBefore;
          if (statusRequests !== 1 || timelineRequests !== 1) {
            throw new Error(
              `Expected one status and timeline request after settlement, got ${statusRequests}/${timelineRequests}`,
            );
          }
          return {
            firstContentMs,
            fullSettlementMs,
            statusRequests,
            timelineRequests,
            fixtureCards: 1,
            ...(sampleRss ? { sampledPeakRendererRssBytes, rssSamples } : {}),
          };
        } finally {
          lifetime.abort();
          try {
            await sampling;
          } finally {
            await session?.detach();
          }
        }
      },
    })),
);
