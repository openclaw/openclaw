import type { Page } from "playwright";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";

type EngineIdleControl = EngineScenario & {
  idle: true;
  idleControl: true;
  prepare: (page: Page) => Promise<void>;
  run: () => Promise<void>;
};

export function isEngineIdleControl(scenario: EngineScenario): scenario is EngineIdleControl {
  return "idleControl" in scenario && scenario.idleControl === true;
}

/** Same native visibility and CPU window as app idle, without an app or Gateway. */
export function createEngineIdleControls(): readonly EngineIdleControl[] {
  return ["blank", "static"].map((kind): EngineIdleControl => ({
    id: `idle-control-${kind}-hidden`,
    idle: true,
    idleControl: true,
    standaloneDocument: true,
    explicitOnly: true,
    viewports: ["desktop"],
    visibility: "hidden",
    route: kind === "blank" ? "about:blank" : "/__idle-static-control",
    expected: "A natively hidden control document remains idle for 30 seconds without input.",
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
        setTimeout(resolve, 30_000);
      }),
  }));
}
