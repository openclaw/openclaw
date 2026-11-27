import type { Page } from "playwright";
import type { BoardSnapshot } from "../../ui/src/lib/board/types.ts";
import type { ProjectionFamily } from "../../ui/src/test-helpers/control-ui-projection-fixture-contract.ts";

/** Each actual board.get request publishes a fresh valid snapshot for its exact session. */
export function createProjectionBoardResponses() {
  const revisions = new Map<string, number>();
  return (params: Record<string, unknown>): BoardSnapshot => {
    const sessionKey = params.sessionKey;
    if (typeof sessionKey !== "string") {
      throw new Error("Projection board fixture requires a session key");
    }
    if (!sessionKey.startsWith("agent:main:projection-")) {
      return { sessionKey, revision: 0, tabs: [], widgets: [] };
    }
    const revision = (revisions.get(sessionKey) ?? 0) + 1;
    revisions.set(sessionKey, revision);
    return {
      sessionKey,
      revision,
      tabs: [{ tabId: "main", title: "Synthetic board", position: 0, chatDock: "hidden" }],
      widgets: Array.from({ length: 400 }, (_, index) => ({
        name: `${revision % 2 ? "absent" : "projection"}-widget-${index}`,
        title: `Synthetic widget ${index}`,
        tabId: "main",
        contentKind: "html",
        grantState: "none",
        position: index,
        sizeW: 1,
        sizeH: 1,
        revision,
      })),
    };
  };
}

export async function prepareProjectionFixture(
  page: Page,
  family: ProjectionFamily,
  instrumented: boolean,
) {
  return page.evaluate(
    async ({ family: selectedFamily, instrumented: withInstrumentation }) => {
      const response = await fetch(new URL("/projection-fixture.json", location.href));
      if (!response.ok) {
        throw new Error("Use the explicit projection benchmark build for this scenario");
      }
      const descriptor: { benchmarkOnly?: boolean; entry?: string } = await response.json();
      if (!descriptor.benchmarkOnly || !descriptor.entry) {
        throw new Error("Missing benchmark-only projection entry identity");
      }
      // Match the page's module URLs; origin-root aliases create a second module graph.
      await import(new URL(descriptor.entry, document.baseURI).href);
      const fixture = window.openclawProjectionFixture;
      if (!fixture) {
        throw new Error("Projection benchmark entry did not install its fixture");
      }
      return fixture.setup(selectedFamily, withInstrumentation);
    },
    { family, instrumented },
  );
}

export async function runProjectionFixture(page: Page) {
  return page.evaluate(() => {
    if (!window.openclawProjectionFixture) {
      throw new Error("Projection fixture is unavailable");
    }
    return window.openclawProjectionFixture.run();
  });
}
export async function finishProjectionFixture(page: Page) {
  return page.evaluate(() => {
    if (!window.openclawProjectionFixture) {
      throw new Error("Projection fixture is unavailable");
    }
    return window.openclawProjectionFixture.finish();
  });
}
export async function disposeProjectionFixture(page: Page) {
  await page.evaluate(() => window.openclawProjectionFixture?.dispose());
}
