import type { Page } from "playwright";
import type { RouteId } from "../../ui/src/app-route-paths.ts";
import type { ColdLoadRpcRecord } from "../../ui/src/test-helpers/control-ui-cold-load-probe-init.ts";
import { waitForControlUiRoute } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { frames } from "./control-ui-interaction-navigation.ts";

export type EnginePageReadiness = {
  ready: string;
  landed?: RouteId;
  rows?: { selector: string; minimum: number; totalSelector?: string };
  /** Keep the measurement open through incremental mounting, after first visibility. */
  completion?: { selector: string; minimum: number; maximum?: number }[];
};

export async function waitForEnginePageReady(
  page: Page,
  id: RouteId,
  definition: EnginePageReadiness,
) {
  await waitForControlUiRoute(page, { routeId: definition.landed ?? id });
  await page
    .locator(definition.ready)
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible" });
  if (definition.rows) {
    await page.waitForFunction(
      ({ selector, minimum, totalSelector }) =>
        document.querySelectorAll(selector).length >= minimum ||
        Boolean(
          totalSelector &&
          [...document.querySelectorAll(totalSelector)].some(
            (row) => row.getAttribute("aria-setsize") === String(minimum),
          ),
        ),
      definition.rows,
    );
  }
  if (definition.completion) {
    await page.waitForFunction(
      (requirements) =>
        requirements.every(({ selector, minimum, maximum }) => {
          const count = document.querySelectorAll(selector).length;
          return count >= minimum && (maximum === undefined || count <= maximum);
        }),
      definition.completion,
    );
  }
  if (id === "cloud-workers") {
    await page.waitForFunction(() => {
      const reads: { rpcs: ColdLoadRpcRecord[]; pendingMethods: string[]; queued: number } =
        Reflect.get(window, "__coldLoad").read();
      const completed = reads.rpcs.filter(
        (rpc) =>
          rpc.method === "environments.list" && rpc.responseOk && rpc.dispatchMs !== undefined,
      );
      return (
        reads.queued === 0 &&
        !reads.pendingMethods.includes("environments.list") &&
        completed.some(
          ({ params }) =>
            params !== null &&
            typeof params === "object" &&
            "projection" in params &&
            params.projection === "profiles",
        ) &&
        completed.some(
          ({ params }) =>
            params !== null &&
            typeof params === "object" &&
            "includePreparedDetails" in params &&
            params.includePreparedDetails === true,
        )
      );
    });
  }
  await frames(page);
}

export async function openInstalledDiscoverySkills(page: Page) {
  await page.getByRole("button", { name: "Installed skills (1,000)", exact: true }).click();
  const installed = '.skill-discovery [data-catalog-section="installed"]';
  await waitForEnginePageReady(page, "skills", {
    ready: `${installed} [data-skill-id]`,
    rows: {
      selector: `${installed} [data-skill-id]`,
      minimum: 1000,
      totalSelector: `${installed} [role="listitem"][aria-setsize]`,
    },
  });
}

export async function filterInstalledDiscoverySkills(page: Page) {
  await page.locator(".skill-discovery input[type=search]").fill("Data skill 0999");
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll(".skill-discovery [data-skill-id]");
    return rows.length === 1 && rows[0]?.getAttribute("data-skill-id") === "local:data-skill-0999";
  });
  await frames(page);
  return { matchingSkills: 1 };
}
