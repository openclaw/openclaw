import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames, navigation } from "./control-ui-interaction-navigation.ts";
import { workboardResourceRoute } from "./control-ui-workboard-resource-fixture.ts";

/** Native owner updates exercise style invalidation without replacing the document. */
export function createEngineStyleScenarios(): readonly EngineScenario[] {
  return [
    {
      id: "workboard-style-cycles",
      explicitOnly: true,
      route: workboardResourceRoute,
      fixture: { workboardResources: true },
      expected:
        "1,000 loaded Workboard cards retain their virtual window through eight resize/scroll cycles.",
      prepare: async (page) => {
        await page.locator(".workboard-page-title", { hasText: "Resource cards" }).waitFor();
        const more = page.getByRole("button", { name: "Load more cards", exact: true });
        for (let count = 100; count < 1_000; count += 100) {
          await page.getByText(`${count} cards loaded.`, { exact: false }).waitFor();
          await more.click();
        }
        await more.waitFor({ state: "hidden" });
        await page.locator(".workboard-card").first().waitFor();
      },
      run: async (page) => {
        const viewport = page.viewportSize()!;
        const column = page
          .locator(".workboard-column__cards")
          .filter({
            has: page.locator(".workboard-card"),
          })
          .first();
        for (let cycle = 0; cycle < 8; cycle++) {
          await page.setViewportSize({ ...viewport, width: viewport.width + (cycle % 2 ? 0 : 64) });
          const nextTop = cycle % 2 ? 0 : 120;
          const scrollTop = await column.evaluate((element, top) => {
            element.scrollTop = top;
            return element.scrollTop;
          }, nextTop);
          if (scrollTop !== nextTop) {
            throw new Error("Workboard column did not scroll to the requested position");
          }
          await frames(page);
        }
        const mountedCards = await page.locator(".workboard-card").count();
        if (mountedCards === 0 || (await page.locator(":popover-open").count())) {
          throw new Error("Workboard lost its card window or opened an unexpected popover");
        }
        return { loadedCards: 1_000, mountedCards, viewportChanges: 8, scrollChanges: 8 };
      },
    },
    {
      id: "theme-switch-cycles",
      explicitOnly: true,
      route: "/new",
      expected: "Eight light/dark preference round trips update the document theme.",
      prepare: async () => {},
      run: async (page, gateway) => {
        for (let cycle = 0; cycle < 8; cycle++) {
          for (const themeMode of ["dark", "light"]) {
            const config = { ui: { prefs: { theme: "claw", themeMode } } };
            await gateway.setMethodResponse("config.get", {
              config,
              raw: JSON.stringify(config),
              hash: `style-${cycle}-${themeMode}`,
            });
            await gateway.emitGatewayEvent("config.changed", {});
            await page.waitForFunction(
              (mode) => document.documentElement.dataset.themeMode === mode,
              themeMode,
            );
            await frames(page);
          }
        }
        return { themeChanges: 16 };
      },
    },
    {
      id: "sidebar-live-style-cycles",
      explicitOnly: true,
      route: "/new",
      expected: "Ten visible session rows adopt eight running/idle lifecycle round trips.",
      prepare: async (page) => navigation(page, "sessions"),
      run: async (page) => {
        const keys = await page
          .locator(".sidebar-recent-session")
          .evaluateAll((rows) =>
            rows.slice(0, 10).map((row) => row.getAttribute("data-session-key")!),
          );
        if (keys.length !== 10) {
          throw new Error(`Expected ten sidebar rows, got ${keys.length}`);
        }
        for (let cycle = 0; cycle < 8; cycle++) {
          for (const running of [true, false]) {
            await page.evaluate(
              ({ keys: sessionKeys, running: active, cycle: revision }) => {
                // SAFETY: installMockGateway installs this typed synthetic transport.
                const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
                if (!gateway) {
                  throw new Error("Missing synthetic Gateway");
                }
                for (const key of sessionKeys) {
                  gateway.emit("sessions.changed", {
                    sessionKey: key,
                    reason: "lifecycle",
                    session: {
                      ...gateway.getSessionRow(key),
                      key,
                      hasActiveRun: active,
                      activeRunIds: active ? [`style-${revision}-${key}`] : [],
                      status: active ? "running" : "done",
                      updatedAt: 1_800_000_000_000 + revision * 2 + (active ? 0 : 1),
                    },
                  });
                }
              },
              { keys, running, cycle },
            );
            await page.waitForFunction(
              ({ keys: sessionKeys, running: active }) =>
                sessionKeys.every((key) => {
                  const row = [...document.querySelectorAll(".sidebar-recent-session")].find(
                    (element) => element.getAttribute("data-session-key") === key,
                  );
                  return row?.classList.contains("session-row-host--running") === active;
                }),
              { keys, running },
            );
            await frames(page);
          }
        }
        return { updatedRows: keys.length, lifecycleEvents: keys.length * 16 };
      },
    },
  ];
}
