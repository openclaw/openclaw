import assert from "node:assert/strict";
import type { Page } from "playwright";
import { pathForAgentPanel, pathForRoute, type RouteId } from "../../ui/src/app-route-paths.ts";
import type { AgentsPanel } from "../../ui/src/lib/agents/panels.ts";
import {
  controlUiSessionPath,
  reconnectMockGateway,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { createEnginePageScenarios } from "./control-ui-engine-page-scenarios.ts";
import { frames, prepareChat } from "./control-ui-interaction-navigation.ts";

const chatPath = controlUiSessionPath("agent:main:interaction-a");
const panels: readonly AgentsPanel[] = [
  "overview",
  "files",
  "tools",
  "skills",
  "channels",
  "cron",
  "memory",
];

async function visit(
  page: Page,
  id: RouteId,
  pathname = pathForRoute(id),
  search = "",
  landed = id,
) {
  await page.evaluate(
    ({ id: routeId, pathname: path, search: routeSearch }) =>
      window.openclawControlUi!.navigate(routeId, { pathname: path, search: routeSearch }),
    { id, pathname, search },
  );
  await waitForControlUiRoute(page, { routeId: landed });
}

async function agentPanelReady(page: Page, panel: AgentsPanel) {
  await waitForControlUiRoute(page, { routeId: "agents" });
  await page.locator(`#agents-tab-${panel}[aria-selected="true"]`).waitFor();
  await page.locator(`#agent-panel[aria-labelledby="agents-tab-${panel}"]`).waitFor();
  await frames(page);
}

/** Dynamic route identities complement the all-route matrix and existing panel actions. */
export function createEngineRemountScenarios(): EngineScenario[] {
  const source = createEnginePageScenarios().find((entry) => entry.id === "page-agents-visit");
  assert(source?.fixtureOverrides, "Missing broad Agents page fixture");
  const fixtureOverrides = source.fixtureOverrides;
  const scenarios: EngineScenario[] = panels.flatMap((from) =>
    panels
      .filter((to) => to !== from)
      .map((to): EngineScenario => ({
        id: `remount-agent-${from}-to-${to}`,
        explicitOnly: true,
        route: pathForAgentPanel("main", from),
        fixtureOverrides,
        expected: `Agent ${from} to ${to} retains the page owner while replacing its panel.`,
        prepare: (page) => agentPanelReady(page, from),
        run: async (page) => {
          await visit(page, "agents", pathForAgentPanel("main", to));
          await agentPanelReady(page, to);
          return { panelTransitions: 1 };
        },
      })),
  );

  const historyPairs: Array<{
    name: string;
    from: RouteId;
    sourcePath: string;
    to: RouteId;
    targetPath: string;
    search?: string;
    landed?: RouteId;
  }> = [
    {
      name: "chat-agents",
      from: "chat",
      sourcePath: chatPath,
      to: "agents",
      targetPath: pathForAgentPanel("main", "overview"),
    },
    {
      name: "new-about",
      from: "new-session",
      sourcePath: "/new",
      to: "about",
      targetPath: "/settings/about",
    },
    {
      name: "new-model-bookmark",
      from: "new-session",
      sourcePath: "/new",
      to: "model-setup",
      targetPath: "/settings/model-setup",
      landed: "model-providers",
    },
    {
      name: "new-settings-bookmark",
      from: "new-session",
      sourcePath: "/new",
      to: "settings",
      targetPath: "/settings",
      search: "?keep=1",
      landed: "chat",
    },
    {
      name: "new-moved-settings-bookmark",
      from: "new-session",
      sourcePath: "/new",
      to: "communications",
      targetPath: "/communications",
      search: "?section=channels",
      landed: "channels",
    },
  ];
  for (const pair of historyPairs) {
    for (const direction of ["back", "forward"] as const) {
      scenarios.push({
        id: `remount-history-${pair.name}-${direction}`,
        explicitOnly: true,
        route: pair.sourcePath,
        fixtureOverrides,
        expected: `Native history ${direction} preserves owners across ${pair.name}.`,
        prepare: async (page) => {
          await waitForControlUiRoute(page, { routeId: pair.from });
          await visit(page, pair.to, pair.targetPath, pair.search, pair.landed);
          if (direction === "forward") {
            await page.goBack();
            await waitForControlUiRoute(page, { routeId: pair.from });
          }
          await frames(page);
        },
        run: async (page) => {
          if (direction === "back") {
            await page.goBack();
          } else {
            await page.goForward();
          }
          const routeId = direction === "back" ? pair.from : (pair.landed ?? pair.to);
          await waitForControlUiRoute(page, { routeId });
          if (routeId === "chat") {
            if (pair.to === "settings") {
              await page
                .locator(".chat-pane-cache__pane--active .agent-chat__composer-shell")
                .waitFor();
            } else {
              await prepareChat(page);
            }
          }
          await frames(page);
          return { historyTransitions: 1 };
        },
      });
    }
  }

  for (const target of ["chat", "new-session", "agents"] as const) {
    for (const restart of [false, true]) {
      const route =
        target === "chat"
          ? chatPath
          : target === "agents"
            ? pathForAgentPanel("main", "overview")
            : "/new";
      scenarios.push({
        id: `remount-${restart ? "restart" : "reconnect"}-${target}`,
        explicitOnly: true,
        route,
        fixtureOverrides,
        expected: `${restart ? "Restart" : "Reconnect"} on ${target} keeps the same presentation scope.`,
        prepare: async (page) => {
          await waitForControlUiRoute(page, { routeId: target });
          if (target === "chat") {
            await prepareChat(page);
          }
        },
        run: async (page, gateway) => {
          await reconnectMockGateway(
            page,
            gateway,
            restart ? `remount-${target}-restart` : undefined,
          );
          await waitForControlUiRoute(page, { routeId: target });
          if (target === "chat") {
            await prepareChat(page);
          }
          await frames(page);
          return { reconnects: 1, restarted: restart };
        },
      });
    }
  }

  for (const pathname of ["/settings/model-setup", "/model-setup"]) {
    scenarios.push({
      id: `remount-bookmark-${pathname === "/model-setup" ? "legacy-" : ""}model-setup`,
      explicitOnly: true,
      route: pathname,
      navigation: "reload",
      fixtureOverrides,
      expected:
        "A bookmarked model-setup URL canonicalizes to Models without an intermediate page.",
      prepare: async (page) => {
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await page.evaluate((path) => window.history.replaceState(null, "", path), pathname);
      },
      run: async (page) => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        await page.locator(".provider-row[data-provider-id]").first().waitFor();
        await frames(page);
        return { bookmarkLoads: 1 };
      },
    });
  }
  return scenarios;
}
