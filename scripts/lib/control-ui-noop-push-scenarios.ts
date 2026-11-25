import assert from "node:assert/strict";
import type { JSHandle, Page } from "playwright";
import type { PresenceEntry } from "../../ui/src/api/types.ts";
import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { interactionScenarios } from "./control-ui-interaction-scenarios.ts";

const observedRows = new WeakMap<Page, JSHandle<{ rows: Element[]; text: string[] }>>();

async function retainRows(page: Page, selector: string) {
  await observedRows.get(page)?.dispose();
  observedRows.set(
    page,
    await page.evaluateHandle((rowSelector) => {
      const rows = Array.from(document.querySelectorAll(rowSelector));
      return { rows, text: rows.map((row) => row.textContent ?? "") };
    }, selector),
  );
}

async function rowEvidence(page: Page) {
  const retained = observedRows.get(page);
  if (!retained) {
    throw new Error("Missing pre-action row observations");
  }
  try {
    return await retained.evaluate(({ rows, text }) => ({
      observedRows: rows.length,
      retainedRows: rows.filter((row) => row.isConnected).length,
      changedRowText: rows.filter((row, index) => row.textContent !== text[index]).length,
    }));
  } finally {
    observedRows.delete(page);
    await retained.dispose();
  }
}

async function emit(page: Page, event: string, payload: unknown) {
  await page.evaluate(
    ({ event: eventName, payload: eventPayload }) => {
      window.openclawEngineMarkGatewayInput?.();
      (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit(eventName, eventPayload);
    },
    { event, payload },
  );
}

const presenceTime = 1_800_000_000_000;
const presenceUsers = Array.from({ length: 20 }, (_, index) => ({
  id: `noop-person-${index}`,
  name: `Synthetic person ${index}`,
  identity: { type: "profile" as const, id: `noop-person-${index}` },
  instanceId: `noop-device-${index}`,
  host: `Synthetic device ${index}`,
  ts: presenceTime,
  lastActivityAt: presenceTime,
  watchedSessions: [`agent:main:data-activity-${index}`],
}));

function presenceEntries(changeOne: boolean): PresenceEntry[] {
  return presenceUsers.map((person, index) => ({
    instanceId: person.instanceId,
    mode: "webchat",
    reason: "connect",
    ts: person.ts,
    lastActivityAt: changeOne && index === 0 ? person.lastActivityAt + 1 : person.lastActivityAt,
    host: person.host,
    user: { id: person.id, identity: person.identity, name: person.name },
    watchedSessions: person.watchedSessions,
  }));
}

export function createNoopPushScenarios(): readonly EngineScenario[] {
  const sessions = interactionScenarios.find(({ id }) => id === "sessions-sort");
  const activity = interactionScenarios.find(({ id }) => id === "data-activity-live-update");
  const picker = interactionScenarios.find(({ id }) => id === "model-picker-first-open-search");
  if (!sessions || !activity || !picker) {
    throw new Error("Missing shared no-op push fixtures");
  }
  let sessionsList: ((params: unknown) => unknown) | undefined;
  return [
    ...([false, true] as const).map((changeOne): EngineScenario =>
      Object.assign({}, sessions, {
        id: `noop-sessions-${changeOne ? "one-row" : "equal"}-push`,
        explicitOnly: true,
        rowSelector: ".session-data-row",
        expected: changeOne
          ? "One session publication changes one visible label and retains unrelated row DOM."
          : "An identical full session publication retains the visible rows and their text.",
        prepare: async (page, gateway) => {
          await sessions.prepare(page, gateway);
          await retainRows(page, ".session-data-row");
        },
        run: async (page, gateway) => {
          const row = await gateway.getSessionRow("agent:main:interaction-a");
          const requestsBefore = (await gateway.getRequests("sessions.list")).length;
          await emit(page, "sessions.changed", {
            agentId: "main",
            reason: "patch",
            session: {
              ...row,
              ...(changeOne ? { label: "Synthetic changed session" } : {}),
              snapshotAt: (row.updatedAt ?? presenceTime) + 1,
            },
            ancestorSessions: [],
          });
          if (changeOne) {
            await page
              .locator(".session-data-row")
              .getByText("Synthetic changed session")
              .waitFor();
          }
          await frames(page);
          return {
            ...(await rowEvidence(page)),
            updatedRows: changeOne ? 1 : 0,
            additionalListRequests:
              (await gateway.getRequests("sessions.list")).length - requestsBefore,
          };
        },
      } satisfies Partial<EngineScenario>),
    ),
    {
      ...sessions,
      id: "noop-sessions-equal-refresh",
      explicitOnly: true,
      rowSelector: ".session-data-row",
      expected: "An explicit same-data session refresh retains row presentation.",
      createRequestHandlers: (defaults) => {
        const handlers = sessions.createRequestHandlers?.(defaults) ?? {};
        sessionsList = handlers["sessions.list"] ?? defaults["sessions.list"];
        return handlers;
      },
      prepare: async (page, gateway) => {
        await sessions.prepare(page, gateway);
        await retainRows(page, ".session-data-row");
      },
      run: async (page, gateway) => {
        assert(sessionsList, "Missing Sessions list handler");
        const rowsBefore = await page.locator(".session-data-row").count();
        const after = await gateway.deferNext("sessions.list", { source: "sessions-page" });
        await page.locator(".sessions-toolbar__refresh").click();
        const request = await gateway.waitForRequest("sessions.list", {
          after,
          match: { source: "sessions-page" },
        });
        const payload = await sessionsList(request.params);
        await page.evaluate((response) => {
          const transport = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          window.openclawEngineMarkGatewayInput?.();
          transport.resolveDeferred("sessions.list", response, {
            match: { source: "sessions-page" },
          });
        }, payload);
        await page.waitForFunction(
          () => !document.querySelector<HTMLButtonElement>(".sessions-toolbar__refresh")?.disabled,
        );
        await frames(page);
        assert.equal(await page.locator(".session-data-row").count(), rowsBefore);
        return { ...(await rowEvidence(page)), updatedRows: 0, explicitRefreshes: 1 };
      },
    },
    ...([false, true] as const).map((changeOne): EngineScenario =>
      Object.assign({}, activity, {
        id: `noop-activity-presence-${changeOne ? "one-row" : "equal"}-push`,
        explicitOnly: true,
        expected: "A presence publication retains all 100 session rows and unchanged timestamps.",
        fixtureOverrides: (sandbox, base) => ({
          ...activity.fixtureOverrides?.(sandbox, base),
          presenceUsers,
        }),
        prepare: async (page, gateway) => {
          await activity.prepare(page, gateway);
          await retainRows(page, ".activity-feed__session-row");
        },
        run: async (page, gateway) => {
          const before = (await gateway.getRequests("sessions.list", { source: "activity" }))
            .length;
          await emit(page, "presence", { presence: presenceEntries(changeOne) });
          await frames(page);
          return {
            ...(await rowEvidence(page)),
            presenceRows: presenceUsers.length,
            changedPresenceRows: changeOne ? 1 : 0,
            additionalListRequests:
              (await gateway.getRequests("sessions.list", { source: "activity" })).length - before,
          };
        },
      } satisfies Partial<EngineScenario>),
    ),
    {
      ...picker,
      id: "noop-model-catalog-equal-refresh",
      explicitOnly: true,
      rowSelector: "[data-chat-model-option]",
      expected: "A metadata invalidation refreshes the open model catalog with identical rows.",
      prepare: async (page, gateway) => {
        await picker.prepare(page, gateway);
        await page.locator(".chat-pane-cache__pane--active [data-chat-model-select]").click();
        await page.locator("[data-chat-model-search]").waitFor();
        await frames(page);
        await retainRows(page, "[data-chat-model-option]");
      },
      run: async (page, gateway) => {
        const after = await gateway.deferNext("models.list");
        await gateway.emitGatewayEvent("chat.metadata.changed", { agentId: "main" });
        await gateway.waitForRequest("models.list", { after });
        await page.evaluate(() => {
          window.openclawEngineMarkGatewayInput?.();
          (window as MockGatewayWindow).openclawControlUiE2eGateway!.resolveDeferred("models.list");
        });
        await page.waitForFunction(
          () => !document.querySelector(".chat-controls__model-menu [data-chat-model-refresh]"),
        );
        await frames(page);
        return {
          ...(await rowEvidence(page)),
          updatedRows: 0,
          catalogRequests: (await gateway.getRequests("models.list")).length - after,
        };
      },
    },
  ];
}
