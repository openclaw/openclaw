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
import { frames, navigation } from "./control-ui-interaction-navigation.ts";
import {
  interactionScenarios,
  settleSidebarBackgroundWork,
} from "./control-ui-interaction-scenarios.ts";
import { readControlUiResourceCounts } from "./control-ui-resource-counts.ts";

export type EngineIdleScenario = EngineScenario & { idle: true };

type EngineIdleControl = EngineIdleScenario & {
  idleControl: true;
  prepare: (page: Page) => Promise<void>;
  run: () => Promise<void>;
};

export function isEngineIdleScenario(scenario: EngineScenario): scenario is EngineIdleScenario {
  return "idle" in scenario && scenario.idle === true;
}

export function isEngineIdleControl(scenario: EngineScenario): scenario is EngineIdleControl {
  return "idleControl" in scenario && scenario.idleControl === true;
}

/** Same native visibility and CPU window as app idle, without an app or Gateway. */
export function createEngineIdleControls(durationMs = 30_000): readonly EngineIdleControl[] {
  return ["blank", "static"].map((kind): EngineIdleControl => ({
    id: `idle-control-${kind}-hidden`,
    idle: true,
    idleControl: true,
    standaloneDocument: true,
    explicitOnly: true,
    viewports: ["desktop"],
    visibility: "hidden",
    route: kind === "blank" ? "about:blank" : "/__idle-static-control",
    expected: `A natively hidden control document remains idle for ${durationMs} ms without input.`,
    setup: async (page) => {
      if (kind === "static") {
        await page.route("**/__idle-static-control", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><title>Idle control</title><p>Static idle control</p>',
          }),
        );
      }
    },
    prepare: async () => {},
    run: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      }),
  }));
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
      running: [...document.querySelectorAll<HTMLElement>(".sidebar-recent-session")]
        .filter((row) => row.querySelector(".session-glyph__ring, .session-glyph__trace-run"))
        .map((row) => {
          const ring = row.querySelector<HTMLElement>(
            ".session-glyph__ring, .session-glyph__trace-run",
          )!;
          const bounds = ring.getBoundingClientRect();
          const port = row.closest(".sidebar-shell__body")?.getBoundingClientRect();
          return {
            key: row.dataset.sessionKey,
            visible:
              document.visibilityState === "visible" &&
              bounds.bottom > (port?.top ?? 0) &&
              bounds.top < (port?.bottom ?? innerHeight) &&
              bounds.right > 0 &&
              bounds.left < innerWidth,
            animation: getComputedStyle(ring).animationName,
            clock: Boolean(row.querySelector("openclaw-elapsed-time")),
          };
        }),
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
    // Compare at the formatter's precision: hour-long runs omit seconds.
    const deadline = Date.now() + 3_000;
    for (;;) {
      const { label, now } = await clock.evaluate((element) => ({
        label: element.textContent?.trim() ?? "",
        now: Date.now(),
      }));
      const expected = [-2_000, -1_000, 0, 1_000, 2_000].map((offset) =>
        formatDurationParts(resolveCompactDurationParts(Math.max(1_000, now - start + offset))!),
      );
      if (expected.includes(label)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Clock did not catch up: ${label}; expected ${expected[2]}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    checked.push({
      key,
      label: await clock.textContent(),
      expected: formatDurationParts(resolveCompactDurationParts(Date.now() - start)!),
    });
  }
  await clocks.first().scrollIntoViewIfNeeded();
  return checked;
}

export function createEngineIdleScenarios(durationMs = 30_000): readonly EngineScenario[] {
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
    expected: `A connected production page retains its route and native visibility for ${durationMs} ms without input.`,
    // The wait belongs to Node; a browser timeout would create measured page work.
    run: async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
      });
    },
  });
  return [
    {
      ...clocks,
      id: "sidebar-running-clock-scroll-resize",
      explicitOnly: true,
      expected: "Running child rows resume their clocks while scrolling and resizing the sidebar.",
      run: async (page) => {
        const clockRows = page.locator(".sidebar-recent-session openclaw-elapsed-time");
        const scroller = page.locator(".sidebar-shell__body").first();
        const distance = await clockRows.last().evaluate((element) => {
          const row = element.closest(".sidebar-recent-session")!;
          const port = element.closest(".sidebar-shell__body")!;
          return row.getBoundingClientRect().bottom - port.getBoundingClientRect().bottom;
        });
        const box = (await scroller.boundingBox())!;
        await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
        const viewport = page.viewportSize()!;
        for (let step = 1; step <= 4; step++) {
          await page.mouse.wheel(0, distance / 4);
          await page.waitForFunction(
            (minimum) => document.querySelector(".sidebar-shell__body")!.scrollTop >= minimum,
            // WebKit rounds each wheel delta to CSS pixels.
            (distance * step) / 4 - step,
          );
          await frames(page);
        }
        await page.setViewportSize({ width: viewport.width + 48, height: viewport.height });
        await frames(page);
        await page.setViewportSize(viewport);
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
    ...[0, 1, 5, 20].flatMap((count) => {
      const desktop = idle(
        {
          ...clocks,
          fixtureOverrides: (_sandbox, base) => ({
            sessions: base.sessions.map((row, index) =>
              index > count && index <= 200
                ? { ...row, hasActiveRun: false, activeRunIds: [], status: "done" }
                : row,
            ),
          }),
          prepare: async (page) => {
            await navigation(page, "sessions");
            const toggle = page.locator('[data-child-session-toggle="agent:main:interaction-a"]');
            if ((await toggle.getAttribute("aria-expanded")) !== "true") {
              await toggle.click();
            }
            const more = page.locator('[data-show-more-children="agent:main:interaction-a"]');
            if ((await more.count()) > 0) {
              await more.click();
            }
            await page.waitForFunction(
              (expected) =>
                document.querySelectorAll(".sidebar-recent-session openclaw-elapsed-time")
                  .length === expected,
              count,
            );
            const viewport = page.viewportSize()!;
            await page.mouse.move(viewport.width - 8, viewport.height - 8);
            await page.locator('[role="tooltip"]:visible').first().waitFor({ state: "hidden" });
            await settleSidebarBackgroundWork(page);
          },
        },
        `idle-sidebar-running-${count}`,
        false,
      );
      if (count !== 1) {
        return [desktop];
      }
      return [
        desktop,
        {
          ...desktop,
          id: "idle-sidebar-clock-mobile-open-1",
          viewports: ["mobile"],
          expected:
            "A touch-capable mobile page retains one visible running-session clock in its open navigation drawer without input.",
          prepare: async (page, gateway) => {
            await desktop.prepare(page, gateway);
            const viewport = page.viewportSize()!;
            const ready = await page.evaluate(({ width, height }) => {
              const drawer = document.querySelector<HTMLElement>(
                ".shell--mobile-nav.shell--nav-drawer-open > .shell-nav",
              );
              const runningClocks = drawer?.querySelectorAll<HTMLElement>(
                ".sidebar-recent-session openclaw-elapsed-time",
              );
              const clock = runningClocks?.[0];
              const row = clock?.closest(".sidebar-recent-session");
              const clockStyle = clock ? getComputedStyle(clock) : undefined;
              // ElapsedTime uses display: contents; measure its rendered text.
              const range = document.createRange();
              if (clock) {
                range.selectNodeContents(clock);
              }
              const bounds = range.getBoundingClientRect();
              const port = clock?.closest(".sidebar-shell__body")?.getBoundingClientRect();
              return {
                viewport: innerWidth === width && innerHeight === height,
                // WebKit/Firefox can emulate touch while reporting zero maxTouchPoints.
                coarsePointer: matchMedia("(pointer: coarse)").matches,
                visibleDocument: document.visibilityState === "visible",
                modalDrawer:
                  drawer?.getAttribute("aria-modal") === "true" &&
                  drawer.getAttribute("aria-hidden") !== "true" &&
                  !drawer.inert,
                oneClock: runningClocks?.length === 1,
                visibleRow:
                  row?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true,
                labeledClock: Boolean(clock?.textContent?.trim()),
                running: Boolean(
                  row?.querySelector(".session-glyph__ring, .session-glyph__trace-run"),
                ),
                visibleText:
                  clockStyle?.visibility === "visible" &&
                  clockStyle.opacity !== "0" &&
                  bounds.width > 0 &&
                  bounds.height > 0 &&
                  bounds.right > 0 &&
                  bounds.left < innerWidth &&
                  bounds.bottom > (port?.top ?? 0) &&
                  bounds.top < (port?.bottom ?? innerHeight),
              };
            }, viewport);
            if (Object.values(ready).some((condition) => !condition)) {
              throw new Error(
                `Mobile idle requires the selected touch viewport, an open modal drawer, and one visible running-session clock: ${JSON.stringify(ready)}`,
              );
            }
          },
        } satisfies EngineIdleScenario,
      ];
    }),
  ];
}
