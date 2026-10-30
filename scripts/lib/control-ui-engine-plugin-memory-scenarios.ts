import path from "node:path";
import { expect, type Page } from "playwright/test";
import { pathForWorkboardBoard } from "../../ui/src/app-route-paths.ts";
import { defaultControlUiFeatureMethods } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../ui/src/test-helpers/control-ui-workboard-fixture.ts";
import { buildWorkboardMocks } from "../../ui/src/test-helpers/control-ui-workboard-fixtures.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { createMcpRelayFixture } from "./plugin-view-benchmark-fixtures.ts";

const now = 1_800_000_000_000;
const rounds = 5;
const updatesPerRound = 50;
const cardCount = 300;
const grantCount = 100;
const boardId = "memory-cards";
const relayRoute = "/plugin?plugin=mcp-relay&id=connected-apps";

async function navigate(page: Page, route: string) {
  await page.evaluate((next) => {
    history.pushState(null, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, route);
}

async function retire(page: Page) {
  await navigate(page, "/new");
  await expect(page.locator(".workboard-board--page, .mcp-connected-apps")).toHaveCount(0);
  await expect(page.locator(".new-session-page__message")).toBeEditable();
  await frames(page);
}

function createWorkboardFixture() {
  const seed = buildWorkboardMocks(now, { id: "memory", label: "Memory benchmark" });
  const statuses = seed.methodResponses["workboard.cards.list"].statuses;
  const cards = Array.from({ length: cardCount }, (_, index) => ({
    ...seed.cards[0]!,
    id: `memory-card-${index}`,
    title: `Memory card ${index}`,
    status: statuses[index % statuses.length]!,
    position: (Math.floor(index / statuses.length) + 1) * 1_000,
    sessionKey: undefined,
    labels: ["Synthetic memory label", "Second memory label", "Third memory label"],
    metadata: { automation: { boardId } },
  }));
  const boards = [
    {
      ...seed.board,
      id: boardId,
      name: "Memory cards",
      automationJobId: undefined,
      total: cardCount,
      active: cardCount,
      byStatus: Object.fromEntries(
        statuses.map((status) => [status, cards.filter((card) => card.status === status).length]),
      ),
    },
  ];
  return {
    cards,
    statuses,
    boards,
    methodResponses: {
      ...seed.methodResponses,
      "workboard.boards.list": { boards },
      "workboard.cards.list": { cards, statuses, boards },
    },
  };
}

/** Production plugin bundles, matching the repeated-update flow in bench-plugin-views. */
export function createEnginePluginMemoryScenarios(): EngineScenario[] {
  const workboard = createWorkboardFixture();
  const relay = createMcpRelayFixture(grantCount, now);
  const workboardRoute = pathForWorkboardBoard(boardId);
  const readyWorkboard = async (page: Page) => {
    await expect(page.locator('[data-card-id="memory-card-0"] h3')).toBeVisible();
    await frames(page);
  };
  const readyRelay = async (page: Page) => {
    await expect(page.locator(".mcp-connected-apps__grant")).toHaveCount(grantCount);
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await page
      .locator(".mcp-connected-apps__grant")
      .first()
      .getByRole("button", { name: "Revoke", exact: true })
      .focus();
    await frames(page);
  };
  const workboardScenario = (mode: "updates" | "idle" | "mounts"): EngineScenario => ({
    id: mode === "updates" ? "memory-workboard-updates" : `memory-workboard-${mode}-control`,
    route: workboardRoute,
    expected:
      mode === "updates"
        ? "Five retired Workboard mounts release 300-card views after 250 verified updates."
        : "One 50-update warmup followed by four idle or mount-only rounds isolates native allocator and Inspector footprint.",
    explicitOnly: true,
    memory: true,
    fixtureOverrides: () => ({
      ...workboardUi,
      nativePlugins: workboardUi.nativePlugins.map((plugin) =>
        Object.assign({}, plugin, {
          rootDir: path.join(process.cwd(), "extensions/workboard"),
        }),
      ),
      featureMethods: [
        ...defaultControlUiFeatureMethods,
        ...Object.keys(workboard.methodResponses),
      ],
      methodResponses: workboard.methodResponses,
    }),
    prepare: readyWorkboard,
    run: async (page, gateway, checkpoint) => {
      if (!checkpoint) {
        throw new Error("Plugin memory scenarios require post-GC checkpoints");
      }
      await retire(page);
      await checkpoint("warm");
      for (let round = 1; round <= rounds; round++) {
        if (mode === "idle" && round > 1) {
          await page.waitForTimeout(5_000);
          await checkpoint(`round-${round}`);
          continue;
        }
        await navigate(page, workboardRoute);
        await readyWorkboard(page);
        if (mode === "updates" || round === 1) {
          for (let update = 1; update <= updatesPerRound; update++) {
            const sequence = (round - 1) * updatesPerRound + update;
            const title = `Memory update ${sequence}`;
            const cards = workboard.cards.map((card, index) =>
              index === 0 ? { ...card, title, updatedAt: now + sequence } : card,
            );
            await gateway.setMethodResponse("workboard.cards.list", {
              cards,
              statuses: workboard.statuses,
              boards: workboard.boards,
            });
            await gateway.emitGatewayEvent("plugin.workboard.changed", {
              epoch: "memory-workboard",
              revision: sequence,
            });
            await expect(page.locator('[data-card-id="memory-card-0"] h3')).toHaveText(title);
          }
        } else {
          await page.waitForTimeout(5_000);
        }
        await retire(page);
        await checkpoint(`round-${round}`);
      }
      return {
        rounds,
        updates: mode === "updates" ? rounds * updatesPerRound : updatesPerRound,
        cards: cardCount,
        idleControl: mode === "idle",
        mountControl: mode === "mounts",
      };
    },
  });
  return [
    ...(["updates", "idle", "mounts"] as const).map(workboardScenario),
    {
      id: "memory-mcp-relay-updates",
      route: relayRoute,
      expected: "Five retired MCP Relay mounts release 100-grant views after 250 verified updates.",
      explicitOnly: true,
      memory: true,
      fixtureOverrides: () => ({
        nativePlugins: [
          {
            pluginId: "mcp-relay",
            rootDir: path.join(process.cwd(), "extensions/mcp-relay"),
            source: "src/control-ui.ts",
          },
        ],
        controlUiTabs: [{ pluginId: "mcp-relay", id: "connected-apps", label: "Connected apps" }],
        featureMethods: [...defaultControlUiFeatureMethods, "mcp-relay.grants", "mcp-relay.pair"],
        methodResponses: { "mcp-relay.grants": relay.snapshot, "mcp-relay.pair": relay.pairing },
      }),
      prepare: readyRelay,
      run: async (page, gateway, checkpoint) => {
        if (!checkpoint) {
          throw new Error("Plugin memory scenarios require post-GC checkpoints");
        }
        await retire(page);
        await checkpoint("warm");
        for (let round = 1; round <= rounds; round++) {
          await navigate(page, relayRoute);
          await readyRelay(page);
          for (let update = 1; update <= updatesPerRound; update++) {
            const sequence = (round - 1) * updatesPerRound + update;
            const clientName = `Memory update ${sequence}`;
            await gateway.setMethodResponse("mcp-relay.grants", {
              ...relay.snapshot,
              grants: relay.snapshot.grants.map((grant, index) =>
                index === 1 ? Object.assign({}, grant, { clientName }) : grant,
              ),
            });
            await page.getByRole("button", { name: "Refresh", exact: true }).click();
            await expect(page.locator(".mcp-connected-apps__grant h2").nth(1)).toHaveText(
              clientName,
            );
            await gateway.emitGatewayEvent("chat.metadata.changed", {
              agentId: "main",
              usageUpdatedAt: now + sequence,
            });
            await frames(page);
          }
          await retire(page);
          await checkpoint(`round-${round}`);
        }
        return { rounds, updates: rounds * updatesPerRound, grants: grantCount };
      },
    },
  ];
}
