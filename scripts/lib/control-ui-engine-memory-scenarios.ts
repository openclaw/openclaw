import { expect, type Page } from "playwright/test";
import { pathForRoute, type RouteId } from "../../ui/src/app-route-paths.ts";
import {
  navigateToControlUiSession,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { parityBaseScenario } from "../control-ui-parity/fixtures.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";

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
  { id: "claws", ready: ".agents-home__claw-empty" },
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

export function createEngineMemoryScenarios(): EngineScenario[] {
  const clawsConfig = { gateway: { controlUi: { experimental: { claws: true } } } };
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
      ...(id === "claws"
        ? {
            featureMethods: [...parityBaseScenario.featureMethods!, "claws.catalog.search"],
            methodResponses: {
              ...parityBaseScenario.methodResponses,
              "config.get": {
                config: clawsConfig,
                raw: JSON.stringify(clawsConfig),
                hash: "memory-claws",
                valid: true,
                issues: [],
              },
              "claws.catalog.search": { entries: [] },
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
