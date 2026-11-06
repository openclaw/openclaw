import type { Page } from "playwright";
import {
  resolveCompactDurationParts,
  formatDurationParts,
} from "../../src/infra/format-time/format-duration-internal.ts";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { parityBaseScenario } from "../control-ui-parity/fixtures.ts";
import { dataUsageScenarios } from "./control-ui-data-usage-scenarios.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { createEnginePageScenarios } from "./control-ui-engine-page-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { interactionScenarios } from "./control-ui-interaction-scenarios.ts";
import { readControlUiResourceCounts } from "./control-ui-resource-counts.ts";

export type EngineIdleScenario = EngineScenario & { idle: true };

export function isEngineIdleScenario(scenario: EngineScenario): scenario is EngineIdleScenario {
  return "idle" in scenario && scenario.idle === true;
}

/** Endpoint reads only: no sampling timer or observer adds work during idle. */
export async function readEngineIdleState(page: Page) {
  const resources = await readControlUiResourceCounts(page);
  const state = await page.evaluate(() => {
    const snapshot = window.openclawControlUi?.snapshot();
    const selectors = [
      ".sidebar-recent-session",
      ".sidebar-recent-session openclaw-elapsed-time",
      ".sidebar-recent-session .hover-marquee__text",
      ".activity-feed__session-row",
      ".sessions-table .session-data-row",
      ".usage-page .session-bar-row",
    ];
    return {
      atMs: performance.now(),
      visibility: document.visibilityState,
      gatewayPhase: snapshot?.gatewayPhase,
      route: location.pathname,
      nodes: document.querySelectorAll("*").length,
      rows: Object.fromEntries(
        selectors.map((selector) => [selector, document.querySelectorAll(selector).length]),
      ),
      samples: selectors.flatMap((selector) =>
        [...document.querySelectorAll<HTMLElement>(selector)].slice(0, 2).map((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            selector,
            text: element.textContent?.trim(),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            style: Object.fromEntries(
              [
                "display",
                "visibility",
                "transform",
                "opacity",
                "animation-name",
                "contain",
                "content-visibility",
              ].map((name) => [name, style.getPropertyValue(name)]),
            ),
          };
        }),
      ),
    };
  });
  return { resources, document: state };
}

/** Correctness probe after CPU/paint collection, including a previously offscreen row. */
export async function verifyEngineIdleClocks(page: Page, gateway: MockGatewayControls) {
  const clocks = page.locator(".sidebar-recent-session openclaw-elapsed-time");
  const checked = [];
  for (const clock of [clocks.first(), clocks.last()]) {
    const key = await clock.evaluate((element) =>
      element.closest("[data-session-key]")?.getAttribute("data-session-key"),
    );
    if (!key) {
      throw new Error("Clock has no session identity");
    }
    const row = await gateway.getSessionRow(key);
    const start =
      typeof row.runtimeMs === "number" && typeof row.runtimeSampledAt === "number"
        ? row.runtimeSampledAt - row.runtimeMs
        : row.startedAt;
    if (typeof start !== "number") {
      throw new Error("Clock fixture has no start time");
    }
    await clock.scrollIntoViewIfNeeded();
    // The shared clock may be up to one tick old; a 30-second frozen label cannot pass.
    await clock.evaluate(
      (element, startedAt) =>
        new Promise<void>((resolve, reject) => {
          const deadline = performance.now() + 3_000;
          const check = () => {
            const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
            const read = element.textContent?.trim() ?? "";
            const seconds = [...read.matchAll(/(\d+)\s*([hms])/gu)].reduce(
              (total, match) =>
                total + Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1),
              0,
            );
            if (Math.abs(seconds - elapsed) <= 2) {
              resolve();
            } else if (performance.now() >= deadline) {
              reject(new Error(`Clock did not catch up: ${read}; expected ${elapsed}s`));
            } else {
              setTimeout(check, 100);
            }
          };
          check();
        }),
      start,
    );
    checked.push({
      key,
      label: await clock.textContent(),
      expected: formatDurationParts(resolveCompactDurationParts(Date.now() - start)!),
    });
  }
  await clocks.first().scrollIntoViewIfNeeded();
  return checked;
}

export function createEngineIdleScenarios(): readonly EngineScenario[] {
  const pages = createEnginePageScenarios();
  const pageSource = (id: string) => {
    const source = pages.find((scenario) => scenario.id === `page-${id}-leave`);
    if (!source) {
      throw new Error(`Missing idle route fixture: ${id}`);
    }
    return source;
  };
  const usage = dataUsageScenarios.find((scenario) => scenario.id === "data-usage-first-render");
  const clocks = interactionScenarios.find((scenario) => scenario.id === "sidebar-clock-idle");
  if (!usage || !clocks) {
    throw new Error("Missing shared idle fixture");
  }
  const sources: Array<{ name: string; source: EngineScenario }> = [
    {
      name: "new",
      source: {
        id: "new",
        route: "/new",
        expected: "",
        prepare: async (page) => {
          await page.locator("openclaw-new-session-page").waitFor();
        },
        run: async () => undefined,
      },
    },
    {
      name: "chat",
      source: {
        id: "chat",
        route: controlUiSessionPath("agent:main:interaction-a"),
        expected: "",
        prepare: async (page) => {
          await page.locator(".chat-pane-cache__pane--active .chat-text").first().waitFor();
        },
        run: async () => undefined,
      },
    },
    { name: "sessions", source: pageSource("sessions") },
    { name: "activity", source: pageSource("activity") },
    {
      name: "usage",
      source: {
        ...usage,
        prepare: async (page, gateway) => {
          await usage.prepare(page, gateway);
          await usage.run(page, gateway);
        },
      },
    },
    { name: "profile", source: pageSource("profile") },
  ];
  const idle = (source: EngineScenario, id: string, hidden: boolean): EngineIdleScenario => ({
    ...source,
    id,
    idle: true,
    explicitOnly: true,
    viewports: ["desktop"],
    settings: { ...source.settings, locale: "en" },
    visibility: hidden ? "hidden" : undefined,
    expected:
      "A connected production page retains its route and native visibility for 30 seconds without input.",
    // The wait belongs to Node; a browser timeout would create measured page work.
    run: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30_000);
      });
    },
  });
  return [
    {
      ...clocks,
      id: "sidebar-running-clock-scroll-resize",
      explicitOnly: true,
      expected: "Running child rows resume their clocks while scrolling and resizing the sidebar.",
      run: async (page, gateway) => {
        const scroller = page.locator(".sidebar-shell__body").first();
        const viewport = page.viewportSize()!;
        for (const fraction of [0.25, 0.5, 0.75, 1]) {
          await scroller.evaluate((element, position) => {
            element.scrollTop = (element.scrollHeight - element.clientHeight) * position;
          }, fraction);
          await frames(page);
        }
        await page.setViewportSize({ width: viewport.width + 48, height: viewport.height });
        await frames(page);
        await page.setViewportSize(viewport);
        await verifyEngineIdleClocks(page, gateway);
      },
    },
    ...sources.flatMap(({ name, source }) =>
      (["realistic", "large"] as const).flatMap((size) => {
        const fixtureSource: EngineScenario = {
          ...source,
          ...(name === "usage" && size === "realistic"
            ? {
                createRequestHandlers: undefined,
              }
            : {}),
          fixtureOverrides: (sandbox, base) => {
            const original = source.fixtureOverrides?.(sandbox, base);
            return {
              ...original,
              ...(name === "usage" && size === "realistic"
                ? {
                    featureMethods: parityBaseScenario.featureMethods,
                    methodResponses: parityBaseScenario.methodResponses,
                  }
                : {}),
              sessions: (original?.sessions ?? base.sessions).slice(
                0,
                size === "realistic" ? 30 : 1_000,
              ),
              sessionTranscripts: Object.fromEntries(
                Object.entries(base.sessionTranscripts).map(([key, value]) => [
                  key,
                  { ...value, messages: value.messages.slice(0, size === "realistic" ? 15 : 400) },
                ]),
              ),
            };
          },
        };
        return [false, true].map((hidden) =>
          idle(fixtureSource, `idle-${name}-${size}-${hidden ? "hidden" : "visible"}`, hidden),
        );
      }),
    ),
    ...[false, true].map((hidden) =>
      idle(clocks, `idle-sidebar-clock-${hidden ? "hidden" : "visible"}`, hidden),
    ),
  ];
}
