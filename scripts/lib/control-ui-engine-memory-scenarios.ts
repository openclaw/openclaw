import { expect, type Page } from "playwright/test";
import { pathForRoute, type RouteId } from "../../ui/src/app-route-paths.ts";
import type { BoardSnapshot } from "../../ui/src/lib/board/types.ts";
import {
  navigateToControlUiSession,
  reconnectMockGateway,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { parityBaseScenario } from "../control-ui-parity/fixtures.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";

/** A working day's churn in one document, sampled at the same parked route. */
function workingDayScenario(rounds: number): EngineScenario {
  const keys = Array.from({ length: 200 }, (_, index) =>
    index === 0 ? parityBaseScenario.sessionKey! : `agent:main:soak-${index}`,
  );
  const settings: RouteId[] = [
    "connection",
    "profile",
    "communications",
    "notifications",
    "security",
    "secrets",
    "advanced",
    "approvals",
    "automation",
    "mcp",
    "memory",
    "search",
    "talk",
    "infrastructure",
    "labs",
    "updates",
    "about",
    "ai-agents",
    "model-providers",
    "devices",
    "cloud-workers",
    "device",
    "device-permissions",
    "skill-settings",
    "plugin-settings",
  ];
  const config = { gateway: { controlUi: { experimental: { templates: true } } } };
  const board = (revision: number): BoardSnapshot => ({
    sessionKey: keys[0]!,
    revision,
    tabs: [{ tabId: "soak", title: "Soak report", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "soak-report",
        tabId: "soak",
        title: "Soak report",
        contentKind: "plugin",
        pluginKind: "session:report",
        sizeW: 12,
        sizeH: 4,
        heightMode: "fixed",
        position: 0,
        grantState: "none",
        revision,
        instanceId: "soak-report",
        props: {
          blocks: [{ type: "metrics", items: [{ label: "Revision", value: `${revision}` }] }],
        },
      },
    ],
  });
  return {
    id: "memory-working-day",
    route: "/new",
    expected: `One document: ${rounds * 20} session switches, ${rounds * 5} streamed turns, route/settings churn, refreshes, dialogs and ${rounds} reconnects.`,
    memory: true,
    explicitOnly: true,
    fixtureOverrides: () => ({
      ...parityBaseScenario,
      terminalEnabled: true,
      featureMethods: [
        ...parityBaseScenario.featureMethods!,
        "terminal.open",
        "templates.catalog.search",
        "board.get",
      ],
      featureEvents: ["board.changed"],
      controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
      sessions: keys.map((key, index) => ({
        key,
        sessionId: `soak-${index}`,
        agentId: "main",
        kind: "direct" as const,
        label: `Soak session ${index}`,
        updatedAt: 1_800_000_000_000,
      })),
      sessionTranscripts: Object.fromEntries(
        keys.map((key, session) => [
          key,
          {
            messages: Array.from({ length: 100 }, (_, index) => ({
              role: index % 2 ? "assistant" : "user",
              content: `Soak session ${session} message ${index}.\n${"Synthetic retained transcript.\n".repeat(4)}`,
              timestamp: 1_800_000_000_000 + index * 1_000,
              __openclaw: { id: `soak-${session}-${index}`, seq: index + 1 },
            })),
          },
        ]),
      ),
      methodResponses: {
        ...parityBaseScenario.methodResponses,
        "config.get": {
          config,
          raw: JSON.stringify(config),
          hash: "soak-config",
          valid: true,
          issues: [],
        },
        "templates.catalog.search": { entries: [] },
        "board.get": board(1),
      },
    }),
    prepare: async () => {},
    run: async (page, gateway, checkpoint) => {
      if (!checkpoint) {
        throw new Error("Working-day soak requires memory collection");
      }
      for (let round = 1; round <= rounds; round++) {
        for (const [index, key] of keys.slice((round - 1) * 20, round * 20).entries()) {
          await navigateToControlUiSession(page, key);
          const pane = page.locator(".chat-pane-cache__pane--active");
          await pane.locator("textarea").first().waitFor();
          await expect(pane).toHaveJSProperty("sessionKey", key);
          if (index % 4 === 0) {
            const turn = (round - 1) * 5 + index / 4;
            const before = (await gateway.getRequests("chat.send")).length;
            await pane.locator("textarea").first().fill(`Synthetic soak turn ${turn}`);
            await pane.locator("textarea").first().press("Enter");
            const request = await gateway.waitForRequest("chat.send", { after: before });
            const runId = (request.params as { idempotencyKey: string }).idempotencyKey;
            let text = "";
            for (let delta = 1; delta <= 50; delta++) {
              text += ` token${delta}`;
              await gateway.emitGatewayEvent("chat", {
                runId,
                sessionKey: key,
                state: "delta",
                deltaText: ` token${delta}`,
                message: { role: "assistant", content: [{ type: "text", text }] },
              });
            }
            await pane
              .locator(".chat-text")
              .getByText(/token50/u)
              .waitFor();
            await gateway.emitChatFinal({
              runId,
              sessionKey: key,
              text: `Soak turn ${turn} complete`,
            });
            await pane
              .locator(".chat-text")
              .getByText(`Soak turn ${turn} complete`, { exact: true })
              .waitFor();
          }
        }
        await page.locator(".chat-pane-cache__pane--active [data-chat-model-select]").click();
        const search = page.locator("[data-chat-model-search]");
        await search.fill("Model 3");
        await search.press("Escape");
        await expect(search).toHaveValue("");
        await search.press("Escape");
        await expect(search).not.toBeVisible();
        await page.keyboard.press("ControlOrMeta+K");
        await page
          .locator("openclaw-command-palette .cmd-palette__input:not([disabled])")
          .waitFor();
        await page.keyboard.press("Escape");
        await expect(
          page.locator("openclaw-command-palette .cmd-palette__input"),
        ).not.toBeVisible();
        for (const { id, ready } of routes) {
          await navigate(page, id);
          await page
            .locator(ready ?? `openclaw-${id}-page`)
            .first()
            .waitFor();
          if (id === "usage") {
            const before = (await gateway.getRequests("sessions.usage")).length;
            await page.getByRole("button", { name: "Refresh", exact: true }).click();
            await gateway.waitForRequest("sessions.usage", { after: before });
          }
          if (id === "dashboard") {
            const before = (await gateway.getRequests("board.get")).length;
            await gateway.setMethodResponse("board.get", board(round + 1));
            await gateway.emitGatewayEvent("board.changed", {
              sessionKey: keys[0],
              revision: round + 1,
            });
            await gateway.waitForRequest("board.get", { after: before });
            await expect(page.locator(".board-report__metrics dd").first()).toHaveText(
              `${round + 1}`,
            );
          }
        }
        for (const id of settings) {
          await navigate(page, id);
        }
        await reconnectMockGateway(page, gateway, `soak-boot-${round}`);
        await navigate(page, "new-session");
        await checkpoint(`round-${round}`);
        console.log(
          JSON.stringify({ soakRound: round, switches: round * 20, streamedTurns: round * 5 }),
        );
      }
      return {
        sessionSwitches: rounds * 20,
        streamedTurns: rounds * 5,
        streamDeltas: rounds * 250,
        reconnects: rounds,
        routeVisits: (routes.length + settings.length) * rounds,
        pickerCycles: rounds,
        dialogCycles: rounds,
      };
    },
  };
}

async function navigate(page: Page, routeId: RouteId) {
  await page.waitForFunction(() => window.openclawControlUi !== undefined);
  await page.evaluate(
    ({ destination, pathname, search }) =>
      window.openclawControlUi!.navigate(destination, { pathname, search }),
    {
      destination: routeId,
      pathname: pathForRoute(routeId),
      search:
        routeId === "dashboard"
          ? `?session=${encodeURIComponent(parityBaseScenario.sessionKey!)}`
          : "",
    },
  );
  await waitForControlUiRoute(page, { routeId });
  await frames(page);
}

// One scene per destination keeps a leaking route attributable. Settings subpages
// share the config owner; appearance exercises its top-level entry/retirement.
const routes: Array<{ id: RouteId; ready?: string }> = [
  { id: "new-session" },
  { id: "terminal", ready: "openclaw-terminal-page .tp-header" },
  { id: "dashboards" },
  { id: "dashboard", ready: "openclaw-chat-page" },
  { id: "custodian", ready: "openclaw-custodian-page .custodian-surface" },
  { id: "activity", ready: "openclaw-activity-page .content-header" },
  { id: "meetings" },
  { id: "apps" },
  { id: "portals" },
  { id: "templates", ready: ".agents-home__template-empty" },
  { id: "agents" },
  { id: "channels" },
  { id: "appearance", ready: "openclaw-config-page" },
  { id: "memory-import" },
  { id: "worktrees" },
  { id: "sessions" },
  { id: "systems" },
  { id: "usage" },
  { id: "debug" },
  { id: "logs", ready: "openclaw-logs-page .content-header" },
  { id: "skills" },
  { id: "skill-workshop" },
  { id: "plugins" },
  { id: "cron" },
];

export function createEngineMemoryScenarios(soakRounds: number): EngineScenario[] {
  const templatesConfig = { gateway: { controlUi: { experimental: { templates: true } } } };
  const routeScenarios: EngineScenario[] = routes.map(({ id, ready }) => ({
    id: `memory-route-${id}`,
    route: "/new",
    expected: `Twenty same-document visits to ${id} retire their presentation owners.`,
    memory: true,
    explicitOnly: true,
    fixtureOverrides: () => ({
      ...parityBaseScenario,
      ...(id === "terminal"
        ? {
            terminalEnabled: true,
            featureMethods: [...parityBaseScenario.featureMethods!, "terminal.open"],
          }
        : {}),
      ...(id === "templates"
        ? {
            featureMethods: [...parityBaseScenario.featureMethods!, "templates.catalog.search"],
            methodResponses: {
              ...parityBaseScenario.methodResponses,
              "config.get": {
                config: templatesConfig,
                raw: JSON.stringify(templatesConfig),
                hash: "memory-templates",
                valid: true,
                issues: [],
              },
              "templates.catalog.search": { entries: [] },
            },
          }
        : {}),
      sessions: parityBaseScenario.sessions?.map((session) =>
        Object.assign({}, session, {
          kind: "direct" as const,
        }),
      ),
    }),
    prepare: async () => {},
    run: async (page, _gateway, checkpoint) => {
      if (!checkpoint) {
        throw new Error("Memory scenario requires the engine memory collector");
      }
      const leave = id === "new-session" ? "appearance" : "new-session";
      const visit = async () => {
        await navigate(page, id);
        await page
          .locator(ready ?? `openclaw-${id}-page`)
          .first()
          .waitFor();
        if (id === "new-session") {
          await page.locator("openclaw-new-session-page").evaluate((element) => {
            const retired: WeakRef<Element>[] =
              Reflect.get(window, "openclawMemoryRetiredDrafts") ?? [];
            retired.push(new WeakRef(element));
            Reflect.set(window, "openclawMemoryRetiredDrafts", retired);
          });
        }
        await navigate(page, leave);
      };
      await visit();
      await checkpoint("warm");
      for (let cycle = 1; cycle <= 20; cycle++) {
        await visit();
        if (cycle % 10 === 0) {
          await checkpoint(`visits-${cycle}`);
        }
      }
      if (id === "new-session") {
        const retained = await page.evaluate(() => {
          const retired: WeakRef<Element>[] = Reflect.get(window, "openclawMemoryRetiredDrafts");
          return retired.filter((reference) => reference.deref()).length;
        });
        expect(retained, "Retired New Session hosts survive forced GC").toBe(0);
      }
      return { visits: 20 };
    },
  }));
  const keys = Array.from({ length: 10 }, (_, index) => `agent:main:memory-${index}`);
  const transcripts = Object.fromEntries(
    keys.map((key, session) => [
      key,
      {
        messages: Array.from({ length: 2_000 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: `Memory session ${session} message ${index}.\n${"Synthetic transcript detail.\n".repeat(4)}`,
          timestamp: 1_800_000_000_000 + index * 1_000,
          __openclaw: { id: `memory-${session}-${index}`, seq: index + 1 },
        })),
      },
    ]),
  );
  return [
    workingDayScenario(soakRounds),
    ...routeScenarios,
    {
      id: "memory-long-session",
      route: "/new",
      expected: "Three rounds load ten 2,000-message sessions, stream, then park Chat.",
      memory: true,
      explicitOnly: true,
      fixtureOverrides: () => ({
        sessions: keys.map((key, index) => ({
          key,
          sessionId: `memory-session-${index}`,
          agentId: "main",
          kind: "direct" as const,
          label: `Memory session ${index}`,
          updatedAt: 1_800_000_000_000,
        })),
        sessionTranscripts: transcripts,
      }),
      prepare: async () => {},
      run: async (page, gateway, checkpoint) => {
        if (!checkpoint) {
          throw new Error("Memory scenario requires the engine memory collector");
        }
        await checkpoint("empty");
        for (let round = 1; round <= 3; round++) {
          for (const [index, key] of keys.entries()) {
            await navigateToControlUiSession(page, key);
            const pane = page.locator(".chat-pane-cache__pane--active");
            const lastMessage = pane.getByText(`Memory session ${index} message 1999.`, {
              exact: false,
            });
            const latest = pane.locator('.chat-scroll-to-bottom[data-visible="true"]');
            // Revisited panes may restore a scrolled position; this workload measures
            // retained transcripts, not automatic scroll-to-latest behavior.
            await lastMessage.or(latest).first().waitFor();
            if (!(await lastMessage.isVisible())) {
              await latest.click();
            }
            await lastMessage.waitFor();
          }
          await checkpoint(`loaded-${round}`);
          const composer = page.locator(".chat-pane-cache__pane--active textarea").first();
          const before = (await gateway.getRequests("chat.send")).length;
          await composer.fill("Synthetic memory stream");
          await composer.press("Enter");
          const request = await gateway.waitForRequest("chat.send", { after: before });
          const runId = (request.params as { idempotencyKey: string }).idempotencyKey;
          let text = "";
          for (let delta = 1; delta <= 200; delta++) {
            text += ` token${delta}`;
            await gateway.emitGatewayEvent("chat", {
              runId,
              sessionKey: keys.at(-1),
              state: "delta",
              deltaText: ` token${delta}`,
              message: { role: "assistant", content: [{ type: "text", text }] },
            });
          }
          await page
            .locator(".chat-pane-cache__pane--active .chat-text")
            .getByText(/token200/u)
            .waitFor();
          await gateway.emitChatFinal({
            runId,
            sessionKey: keys.at(-1)!,
            text: `Memory stream ${round} complete`,
          });
          await page
            .locator(".chat-pane-cache__pane--active .chat-text")
            .getByText(`Memory stream ${round} complete`, { exact: true })
            .waitFor();
          await checkpoint(`streamed-${round}`);
          await navigate(page, "new-session");
          await checkpoint(`closed-${round}`);
        }
        return { sessions: 10, messagesPerSession: 2_000, rounds: 3, streamDeltas: 600 };
      },
    },
  ];
}
