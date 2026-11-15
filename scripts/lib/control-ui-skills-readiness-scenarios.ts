import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { createSkill } from "../../ui/src/pages/skills/view.test-support.ts";
import { waitForControlUiRoute } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import type { InteractionScenario } from "./control-ui-interaction-scenarios.ts";
import { readRendererProcessSnapshot } from "./control-ui-renderer-metrics.ts";

const skillId = "12345678-1234-1234-1234-123456789abc";
const librarySelector = '[data-skill-id="library:' + skillId + '"]';
const statusSelector = '[data-skill-id="local:settled-status"]';
const refreshedStatusSelector = '[data-skill-id="local:refreshed-status"]';

// Explicit-only production-bundle scenes; the existing harness owns AB/control,
// fresh-browser custody, CPU counters, traces, and fixture transport.
export const skillsReadinessScenarios: InteractionScenario[] = [false, true].flatMap((warm) =>
  [false, true].map((sampleRss) => ({
    id:
      (warm ? "data-skills-revisit-250ms" : "data-skills-first-content-250ms") +
      (sampleRss ? "-rss" : ""),
    diagnostic: sampleRss
      ? "Synchronous RSS polling; use only its sampled RSS, not latency or CPU comparisons."
      : undefined,
    route: "/new",
    dataPage: "skills",
    explicitOnly: true,
    observationBrowser: true,
    expected:
      "Skills library and the eventual installed-status sentinel are usable without duplicate reads.",
    rowSelector: "[data-skill-id]",
    fixtureOverrides: () => ({
      sessions: [],
      communityInvite: false,
      automaticallyFetchFavicons: false,
      featureMethods: ["skills.status", "skills.library.list", "skills.search"],
      methodResponses: {
        "skills.status": {
          workspaceDir: "/synthetic",
          managedSkillsDir: "/synthetic/skills",
          skills: [createSkill({ name: "Status settled", skillKey: "settled-status" })],
        },
        "skills.library.list": {
          entries: [
            {
              skillId,
              revision: "a".repeat(64),
              slug: "existing-skill",
              name: "existing-skill",
              description: "Synthetic readiness fixture",
              ownerProfileId: "alice",
              authorProfileId: "alice",
              ownerLabel: "Alice",
              shared: false,
              enabled: true,
              removed: false,
              canEdit: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          profileId: "alice",
          multipleProfiles: true,
          defaultTarget: "personal",
          canManageWorkspace: true,
          defaultSelectionLimit: 64,
        },
        "skills.search": { results: [] },
      },
    }),
    prepare: async (page, gateway) => {
      if (warm) {
        await page.evaluate(() => window.openclawControlUi!.navigate("skills"));
        await page.locator(statusSelector).waitFor({ state: "visible" });
        await page.evaluate(() => window.openclawControlUi!.navigate("new-session"));
        await waitForControlUiRoute(page, { routeId: "new-session" });
        await gateway.setMethodResponse("skills.status", {
          workspaceDir: "/synthetic",
          managedSkillsDir: "/synthetic/skills",
          skills: [createSkill({ name: "Status refreshed", skillKey: "refreshed-status" })],
        });
      }
      await gateway.setMethodDelay("skills.status", 250);
      await frames(page);
    },
    run: async (page: Page, gateway) => {
      const browser = page.context().browser();
      if (!browser) {
        throw new Error("Readiness measurement requires its owned Chromium browser");
      }
      const processSession = sampleRss ? await browser.newBrowserCDPSession() : null;
      const samplingLifetime = new AbortController();
      const initialRows = processSession ? await readRendererProcessSnapshot(processSession) : [];
      let sampledPeakRendererRssBytes = initialRows.reduce((sum, row) => sum + row.rssBytes, 0);
      let rssSamples = initialRows.length ? 1 : 0;
      // Read only owner-validated renderer PIDs. The 25 ms sampler is observational,
      // not a true peak or a retained-memory/leak measurement.
      const sampling = (async () => {
        if (!processSession) {
          return;
        }
        try {
          while (!samplingLifetime.signal.aborted) {
            const rows = await readRendererProcessSnapshot(processSession);
            sampledPeakRendererRssBytes = Math.max(
              sampledPeakRendererRssBytes,
              rows.reduce((sum, row) => sum + row.rssBytes, 0),
            );
            rssSamples++;
            await delay(25, undefined, { signal: samplingLifetime.signal });
          }
        } catch (error) {
          // Native timer cancellation is normal completion; other failures invalidate the sample.
          if (!(error instanceof Error && error.name === "AbortError")) {
            throw error;
          }
        }
      })();
      void sampling.catch(() => undefined);
      try {
        const before = (await gateway.getRequests("skills.status")).length;
        const started = await page.evaluate(() => performance.now());
        await page.evaluate(() => window.openclawControlUi!.navigate("skills"));
        await page.locator(librarySelector).waitFor({ state: "visible" });
        const firstContentMs = await page.evaluate((start) => performance.now() - start, started);
        await waitForControlUiRoute(page, { routeId: "skills" });
        const admittedStatusRequests = (await gateway.getRequests("skills.status")).length - before;
        // A warm cached route can issue no read; an admitted read must publish its new marker.
        if (admittedStatusRequests > 0) {
          await page
            .locator(warm ? refreshedStatusSelector : statusSelector)
            .waitFor({ state: "visible" });
        }
        await frames(page);
        const fullSettlementMs = await page.evaluate((start) => performance.now() - start, started);
        const statusRequests = (await gateway.getRequests("skills.status")).length - before;
        if ((!warm && statusRequests !== 1) || statusRequests > 1) {
          throw new Error("Skills readiness issued an unexpected number of installed-status reads");
        }
        return {
          firstContentMs,
          fullSettlementMs,
          statusRequests,
          fixtureLibraryEntries: 1,
          fixtureInstalledSkills: 1,
          ...(sampleRss ? { sampledPeakRendererRssBytes, rssSamples } : {}),
        };
      } finally {
        samplingLifetime.abort();
        try {
          await sampling;
        } finally {
          await processSession?.detach();
        }
      }
    },
  })),
);
