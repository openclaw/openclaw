import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import { createColdLoadProbeInitScript } from "../../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { createEnginePageScenarios } from "./control-ui-engine-page-scenarios.ts";

function installProfileReadinessProbe() {
  const sample = () => {
    if (document.documentElement.style.getPropertyValue("--accent").trim() !== "#336699") {
      requestAnimationFrame(sample);
      return;
    }
    const reads: { pendingMethods: string[]; rpcs: { method: string }[] } = Reflect.get(
      window,
      "__coldLoad",
    ).read();
    Reflect.set(window, "__profileReadiness", {
      appearanceReadyMs: performance.now(),
      configPendingAtAppearance: reads.pendingMethods.includes("config.get"),
      profileResponsesAtAppearance: reads.rpcs.filter(({ method }) => method === "users.prefs.get")
        .length,
    });
  };
  requestAnimationFrame(sample);
}

/** Missing bootstrap preferences must not serialize explicit profile display behind config. */
export function createEngineProfileReadinessScenarios(
  baseUrl: string,
  gatewayLatencyMs = 0,
): readonly EngineScenario[] {
  const base = createEnginePageScenarios(gatewayLatencyMs, "new-session", baseUrl).find(
    ({ id }) => id === "page-about-visit",
  )!;
  return [
    {
      ...base,
      id: "page-profile-appearance-visit",
      route: pathForRoute("about"),
      navigation: "measured",
      expected:
        "Without bootstrap display preferences, explicit profile appearance publishes independently of operator config.",
      initScript: `${createColdLoadProbeInitScript({
        ownerProbes: false,
        sidebarCounters: false,
        latencyMs: gatewayLatencyMs,
        frameGapMs: 0,
        events: [],
      })};(() => { const __name = (fn) => fn; (${installProfileReadinessProbe.toString()})(); })();`,
      settings: { accent: "#112233" },
      fixtureOverrides: (sandbox, fixture) => {
        const source = base.fixtureOverrides?.(sandbox, fixture) ?? fixture;
        return {
          ...source,
          bootstrapPreferences: undefined,
          methodResponses: {
            ...source.methodResponses,
            "users.prefs.get": {
              status: "ok",
              entries: { "ui.accent": "#336699", "ui.railShortcuts": [] },
            },
          },
        };
      },
      prepare: async () => {},
      run: async (page) => {
        await page.goto(new URL(pathForRoute("about"), baseUrl).href);
        await page.waitForFunction(() => Boolean(Reflect.get(window, "__profileReadiness")));
        return page.evaluate(() => {
          const evidence: {
            appearanceReadyMs: number;
            configPendingAtAppearance: boolean;
            profileResponsesAtAppearance: number;
          } = Reflect.get(window, "__profileReadiness");
          if (evidence.profileResponsesAtAppearance !== 1) {
            throw new Error("Appearance published without exactly one authoritative profile read");
          }
          return evidence;
        });
      },
    },
  ];
}
