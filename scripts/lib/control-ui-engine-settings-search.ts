import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { createEnginePageScenarios } from "./control-ui-engine-page-scenarios.ts";

/** Search needs schema labels before a separately delayed config snapshot can finish. */
export function createEngineSettingsSearchScenarios(
  baseUrl: string,
  gatewayLatencyMs = 0,
): readonly EngineScenario[] {
  const base = createEnginePageScenarios(gatewayLatencyMs, "new-session", baseUrl).find(
    ({ id }) => id === "page-about-visit",
  )!;
  return [
    {
      ...base,
      id: "page-settings-search-visit",
      route: pathForRoute("about"),
      navigation: "measured",
      expected:
        "A schema-only Settings search finds its section while config loads; search remains editable.",
      fixtureOverrides: (sandbox, fixture) => {
        const source = base.fixtureOverrides?.(sandbox, fixture) ?? fixture;
        return {
          ...source,
          methodResponses: {
            ...source.methodResponses,
            "config.schema": {
              version: "settings-search-benchmark",
              uiHints: {},
              schema: {
                type: "object",
                properties: {
                  gateway: {
                    type: "object",
                    properties: { port: { type: "number", title: "Listener census setting" } },
                  },
                },
              },
            },
          },
        };
      },
      prepare: async () => {},
      run: async (page) => {
        await page.goto(new URL(pathForRoute("about"), baseUrl).href);
        const search = page.locator(".settings-sidebar__search-input");
        await search.waitFor({ state: "visible" });
        return page.evaluate(async () => {
          const input = document.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
          if (!input || input.disabled) {
            throw new Error("Settings search is unavailable");
          }
          const started = performance.now();
          input.value = "Listener census setting";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise<void>((resolve, reject) => {
            const sample = () => {
              const result = document.querySelector<HTMLElement>(
                '.settings-sidebar__subitem[href*="section=gateway"]',
              );
              if (result?.checkVisibility()) {
                resolve();
              } else if (performance.now() - started > 15_000) {
                reject(new Error("Settings search did not publish its schema match"));
              } else {
                requestAnimationFrame(sample);
              }
            };
            requestAnimationFrame(sample);
          });
          if (input.disabled || input.value !== "Listener census setting") {
            throw new Error("Settings search lost the query or became disabled");
          }
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          return {
            searchReadyMs: performance.now() - started,
            inputCharacters: input.value.length,
            configRequests: gateway.findRequests("config.get").length,
            schemaRequests: gateway.findRequests("config.schema").length,
          };
        });
      },
    },
  ];
}
