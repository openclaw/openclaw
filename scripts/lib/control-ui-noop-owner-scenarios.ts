import assert from "node:assert/strict";
import type { JSHandle, Page } from "playwright";
import type {
  EnvironmentSummary,
  PendingApprovalSnapshot,
  QuestionRecord,
} from "../../packages/gateway-protocol/src/index.ts";
import type { DevicePairingList } from "../../src/gateway/device-pairing-list.types.ts";
import { PORTAL_PANEL_TOGGLE_EVENT } from "../../ui/src/components/panel-toggle-contract.ts";
import type { PortalsPage } from "../../ui/src/pages/portals/portals-page.tsx";
import { createColdLoadProbeInitScript } from "../../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiSessionPath,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { createEnginePageScenarios } from "./control-ui-engine-page-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import {
  interactionScenarios,
  type InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";
import { workboardResourceResponses } from "./control-ui-workboard-resource-fixture.ts";

type PortalsPageHost = Extract<Parameters<typeof PortalsPage>[0]["ref"], HTMLElement>;

const retainedRows = new WeakMap<Page, JSHandle<{ rows: Element[]; text: string[] }>>();

async function retainRows(page: Page, selector: string) {
  retainedRows.set(
    page,
    await page.evaluateHandle((rowSelector) => {
      const rows = Array.from(document.querySelectorAll(rowSelector));
      if (rows.length === 0) {
        throw new Error(`Missing owner rows: ${rowSelector}`);
      }
      return { rows, text: rows.map((row) => row.textContent ?? "") };
    }, selector),
  );
}

async function rowEvidence(page: Page) {
  const retained = retainedRows.get(page);
  assert(retained, "Missing pre-action owner rows");
  try {
    return await retained.evaluate(({ rows, text }) => ({
      observedRows: rows.length,
      retainedRows: rows.filter((row) => row.isConnected).length,
      changedRowText: rows.filter((row, index) => row.textContent !== text[index]).length,
    }));
  } finally {
    retainedRows.delete(page);
    await retained.dispose();
  }
}

async function settle(page: Page) {
  await page.waitForFunction(() => {
    const reads: { pendingMethods: string[]; queued: number } = Reflect.get(
      window,
      "__coldLoad",
    ).read();
    return reads.queued === 0 && reads.pendingMethods.length === 0;
  });
  await frames(page);
}

async function releasePoll(page: Page, method: string | string[]) {
  await page.evaluate(
    (methods) => {
      window.openclawEngineMarkGatewayInput?.();
      for (const pendingMethod of methods) {
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.resolveDeferred(pendingMethod);
      }
    },
    typeof method === "string" ? [method] : method,
  );
  await settle(page);
}

async function waitForPoll(
  page: Page,
  method: string,
  after: number,
  intervalMs: number,
  match?: Record<string, unknown>,
) {
  // The usual request wait is 10s; some production timers intentionally run at 10–15s.
  await page.waitForFunction(
    ({ method: pollMethod, after: count, match: parameters }) =>
      (window as MockGatewayWindow).openclawControlUiE2eGateway!.findRequests(
        pollMethod,
        parameters,
      ).length > count,
    { method, after, match },
    { polling: 50, timeout: intervalMs + 10_000 },
  );
}

const time = 1_800_000_000_000;
function pendingWorker(index: number): EnvironmentSummary {
  return {
    id: `worker:noop-${index}`,
    type: "worker",
    status: "starting",
    label: `Synthetic pending worker ${index}`,
    platform: "linux",
    desktop: false,
    preparation: {
      purpose: "reserve",
      key: `noop-${index}`,
      details: {
        demandAtMs: time,
        expiresAtMs: time + 86_400_000,
        consumedAtMs: null,
        project: { label: `Synthetic repository ${index}`, baseCommit: "0123456789abcdef" },
      },
    },
    worker: {
      providerId: "crabbox",
      profileId: `worker-${index}`,
      state: "provisioning",
      ageMs: 60_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  };
}

export function createNoopOwnerScenarios(): readonly EngineScenario[] {
  const pages = createEnginePageScenarios();
  const pageScenario = (id: string) => {
    const source = pages.find((scenario) => scenario.id === id);
    assert(source, `Missing page fixture: ${id}`);
    return source;
  };
  const interactionScenario = (id: string) => {
    const source = interactionScenarios.find((scenario) => scenario.id === id);
    assert(source, `Missing interaction fixture: ${id}`);
    return source;
  };
  const activity = interactionScenarios.find(
    (scenario) => scenario.id === "data-activity-live-update",
  );
  assert(activity, "Missing Activity session fixture");
  const dashboards = pageScenario("page-dashboards-push");
  const systems = pageScenario("page-systems-push");
  const appearance = pageScenario("page-appearance-push");
  const cloudWorkers = pageScenario("page-cloud-workers-visit");
  const devices = pageScenario("page-devices-push");
  const profile = pageScenario("page-profile-push");
  const portals = pageScenario("page-portals-push");
  const documentTime = Date.now();
  const approval: PendingApprovalSnapshot = {
    id: "noop-pending-approval",
    status: "pending",
    urlPath: "/approve/noop-pending-approval",
    createdAtMs: documentTime,
    expiresAtMs: documentTime + 86_400_000,
    presentation: {
      kind: "exec",
      commandText: Array.from(
        { length: 14 },
        (_, index) => `printf 'Synthetic approval step ${index + 1}\\n'`,
      ).join("\n"),
      host: "gateway",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
  const questionPrompt = "Choose a synthetic target.";
  const question: QuestionRecord = {
    id: "noop-pending-question",
    status: "pending",
    agentId: "main",
    createdAtMs: documentTime,
    expiresAtMs: documentTime + 86_400_000,
    questions: [
      {
        questionId: "target",
        header: "Target",
        question: questionPrompt,
        options: Array.from({ length: 12 }, (_, index) => ({
          label: `Synthetic choice ${index + 1}`,
        })),
      },
    ],
  };
  const documentProbe = createColdLoadProbeInitScript({
    ownerProbes: false,
    sidebarCounters: false,
    latencyMs: 0,
    frameGapMs: 0,
    events: [],
  });
  const approvalPoll: EngineScenario = {
    id: "noop-standalone-approval-pending-poll",
    route: approval.urlPath,
    expected: "The standalone approval's native two-second poll retains the same pending decision.",
    explicitOnly: true,
    standaloneDocument: true,
    initScript: documentProbe,
    rowSelector: ".approval-page__content",
    fixtureOverrides: () => ({
      featureMethods: ["approval.get", "approval.resolve"],
      methodResponses: { "approval.get": { approval } },
    }),
    prepare: async (page, gateway) => {
      await gateway.waitForRequest("approval.get", { match: { id: approval.id } });
      await page.locator("openclaw-approval-page .approval-page[data-state=pending]").waitFor();
      assert.equal(await page.locator("openclaw-app-shell, .shell").count(), 0);
      await settle(page);
      await retainRows(page, ".approval-page__content");
    },
    run: async (page, gateway) => {
      const match = { id: approval.id };
      const after = await gateway.deferNext("approval.get", match);
      await waitForPoll(page, "approval.get", after, 2_000, match);
      await releasePoll(page, "approval.get");
      assert.equal(await page.locator(".approval-page").getAttribute("data-state"), "pending");
      return { ...(await rowEvidence(page)), unchangedApproval: true, intervalMs: 2000 };
    },
  };
  const questionPush: EngineScenario = {
    id: "noop-standalone-question-equal-push",
    route: `/ask/${question.id}`,
    expected: "An identical question.requested event retains the standalone question's choices.",
    explicitOnly: true,
    standaloneDocument: true,
    initScript: documentProbe,
    rowSelector: ".chat-question-panel__option",
    fixtureOverrides: () => ({
      operatorScopes: ["operator.admin", "operator.read", "operator.write", "operator.questions"],
      featureMethods: ["question.get", "question.list", "question.resolve"],
      methodResponses: {
        "question.get": { question },
        "question.list": { questions: [question] },
      },
    }),
    prepare: async (page, gateway) => {
      await gateway.waitForRequest("question.get", { match: { id: question.id } });
      await page.getByText(questionPrompt, { exact: true }).waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll(".chat-question-panel__option").length === 12,
      );
      assert.equal(await page.locator("openclaw-app-shell, .shell").count(), 0);
      await settle(page);
      await retainRows(page, ".chat-question-panel__option");
    },
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("question.get")).length;
      await page.evaluate((incomingQuestion) => {
        window.openclawEngineMarkGatewayInput?.();
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit(
          "question.requested",
          incomingQuestion,
        );
      }, question);
      await settle(page);
      return {
        ...(await rowEvidence(page)),
        unchangedQuestion: true,
        additionalGetRequests: (await gateway.getRequests("question.get")).length - before,
      };
    },
  };
  const deviceInventory: DevicePairingList = {
    pending: [],
    paired: Array.from({ length: 30 }, (_, index) => ({
      deviceId: `noop-paired-${index}`,
      displayName: `Synthetic paired device ${index}`,
      platform: "linux",
      connected: false,
      createdAtMs: time - 86_400_000,
      approvedAtMs: time - 86_400_000,
      lastSeenAtMs: time,
      tokens: [{ role: "operator", scopes: ["operator.read"] }],
    })),
  };
  const devicesPoll: EngineScenario = {
    ...devices,
    id: "noop-devices-paired-inventory-poll",
    rowSelector: ".device-entry[data-device-id]",
    expected: "The native 30-second Devices poll receives the same nodes and paired devices.",
    fixtureOverrides: (sandbox, base) => {
      const fixture = devices.fixtureOverrides?.(sandbox, base) ?? {};
      return {
        ...fixture,
        methodResponses: {
          ...fixture.methodResponses,
          "device.pair.list": deviceInventory,
        },
      };
    },
    prepare: async (page, gateway) => {
      await devices.prepare(page, gateway);
      await page.waitForFunction(
        () => document.querySelectorAll('[data-device-id^="noop-paired-"]').length === 30,
      );
      await retainRows(page, ".device-entry[data-device-id]");
    },
    run: async (page, gateway) => {
      const nodesAfter = await gateway.deferNext("node.list");
      const devicesAfter = await gateway.deferNext("device.pair.list");
      await Promise.all([
        waitForPoll(page, "node.list", nodesAfter, 30_000),
        waitForPoll(page, "device.pair.list", devicesAfter, 30_000),
      ]);
      await releasePoll(page, ["node.list", "device.pair.list"]);
      return { ...(await rowEvidence(page)), unchangedPairedDevices: 30, intervalMs: 30000 };
    },
  };
  const profileRefresh: EngineScenario = {
    ...profile,
    id: "noop-profile-combined-refresh",
    rowSelector: "openclaw-profile-page input, openclaw-profile-page button",
    expected:
      "Explicit Profile refresh reloads equal identity, preferences, and model accounts together.",
    prepare: async (page, gateway) => {
      await profile.prepare(page, gateway);
      await page.locator(".profile-refresh:enabled").waitFor();
      await retainRows(page, "openclaw-profile-page input, openclaw-profile-page button");
    },
    run: async (page, gateway) => {
      const methods = ["users.self", "users.prefs.get", "users.listModelAccounts"];
      const before = await Promise.all(
        methods.map(async (method) => (await gateway.getRequests(method)).length),
      );
      await page.locator(".profile-refresh:enabled").click();
      await Promise.all(
        methods.map((method, index) => gateway.waitForRequest(method, { after: before[index] })),
      );
      await settle(page);
      await page.locator(".profile-refresh:enabled").waitFor();
      return { ...(await rowEvidence(page)), unchangedOwnerReads: methods.length };
    },
  };
  let activityList: ((params: unknown) => unknown) | undefined;
  const activityFallback: EngineScenario = {
    ...activity,
    id: "noop-activity-facets-fallback",
    initScript: documentProbe,
    explicitOnly: true,
    rowSelector: ".activity-feed__session-row",
    expected:
      "After a reconciled receipt, Activity's real 60-second fallback and debounce reload unchanged facets.",
    createRequestHandlers: (defaults) => {
      const handlers = activity.createRequestHandlers?.(defaults) ?? {};
      activityList = handlers["sessions.list"] ?? defaults["sessions.list"];
      return handlers;
    },
    prepare: async (page, gateway) => {
      await activity.prepare(page, gateway);
      const row = await gateway.getSessionRow("agent:main:data-activity-0");
      await gateway.emitGatewayEvent("sessions.changed", {
        agentId: "main",
        reason: "patch",
        session: { ...row, snapshotAt: Math.max(row.updatedAt ?? 0, Date.now(), time) + 1 },
        ancestorSessions: [],
      });
      await settle(page);
      assert.equal(await page.locator(".activity-feed__session-row").count(), 100);
      await retainRows(page, ".activity-feed__session-row");
    },
    run: async (page, gateway) => {
      assert(activityList, "Missing Activity list handler");
      const match = { source: "activity" };
      const after = await gateway.deferNext("sessions.list", match);
      // The shared owner adds its normal 4–5s debounce after the 60s fallback.
      await waitForPoll(page, "sessions.list", after, 65_000, match);
      const request = (await gateway.getRequests("sessions.list", match))[after];
      assert(request, "Missing deferred Activity list request");
      const payload = await activityList(request.params);
      await page.evaluate((response) => {
        const transport = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
        window.openclawEngineMarkGatewayInput?.();
        transport.resolveDeferred("sessions.list", response, { match: { source: "activity" } });
      }, payload);
      await settle(page);
      assert.equal(await page.locator(".activity-feed__session-row").count(), 100);
      return { ...(await rowEvidence(page)), unchangedActivitySnapshot: true, fallbackMs: 60000 };
    },
  };
  const pendingEnvironment = pendingWorker(99);
  const portalsPoll: EngineScenario = {
    ...portals,
    id: "noop-portals-pending-environment-poll",
    rowSelector: "openclaw-portals-page .portals-empty",
    expected: "The native two-second Portals poll receives the same pending environment.",
    fixtureOverrides: (sandbox, base) => {
      const fixture = portals.fixtureOverrides?.(sandbox, base) ?? {};
      return {
        ...fixture,
        featureMethods: [...new Set([...(fixture.featureMethods ?? []), "environments.status"])],
        methodResponses: {
          ...fixture.methodResponses,
          "environments.status": pendingEnvironment,
        },
      };
    },
    prepare: async (page, gateway) => {
      await portals.prepare(page, gateway);
      await page.evaluate(
        ({ type, environmentId }) => {
          const host = document.querySelector<PortalsPageHost>("openclaw-portals-page");
          if (!host) {
            throw new Error("Missing Portals host");
          }
          // Use the public presentation command used by the shell; no environment is created.
          host.handleToggleRequest(
            new CustomEvent(type, { detail: { open: true, environmentId } }),
          );
        },
        { type: PORTAL_PANEL_TOGGLE_EVENT, environmentId: pendingEnvironment.id },
      );
      await gateway.waitForRequest("environments.status", {
        match: { environmentId: pendingEnvironment.id },
      });
      await page.locator("openclaw-portals-page .portals-empty").waitFor();
      await settle(page);
      await retainRows(page, "openclaw-portals-page .portals-empty");
    },
    run: async (page, gateway) => {
      const match = { environmentId: pendingEnvironment.id };
      const after = await gateway.deferNext("environments.status", match);
      await waitForPoll(page, "environments.status", after, 2_000, match);
      await releasePoll(page, "environments.status");
      return { ...(await rowEvidence(page)), unchangedEnvironment: true, intervalMs: 2000 };
    },
  };

  const sessions = (["activity", "dashboards"] as const).flatMap((surface) => {
    const source = surface === "activity" ? activity : dashboards;
    const rowSelector = surface === "activity" ? ".activity-feed__session-row" : ".dashboard-card";
    const keySelector =
      surface === "activity" ? "[data-activity-session]" : "[data-dashboard-session]";
    const keyAttribute =
      surface === "activity" ? "data-activity-session" : "data-dashboard-session";
    return ([false, true] as const).map((changed): EngineScenario =>
      Object.assign({}, source, {
        id: `noop-${surface}-session-${changed ? "one-row" : "equal"}-push`,
        explicitOnly: true,
        rowSelector,
        expected: `A ${changed ? "single changed" : "semantically identical"} session receipt preserves unrelated ${surface} rows.`,
        prepare: async (page, gateway) => {
          await source.prepare(page, gateway);
          await retainRows(page, rowSelector);
        },
        run: async (page, gateway) => {
          const key = await page.locator(keySelector).first().getAttribute(keyAttribute);
          assert(key, `Missing visible ${surface} session key`);
          const row = await gateway.getSessionRow(key);
          const after = (await gateway.getRequests("sessions.list")).length;
          const stamp = Math.max(row.updatedAt ?? 0, Date.now(), time) + 1;
          const text = `Synthetic ${surface} changed session`;
          await page.evaluate(
            ({
              row: incomingRow,
              stamp: snapshotAt,
              changed: changeOne,
              surface: targetSurface,
              text: updatedText,
            }) => {
              window.openclawEngineMarkGatewayInput?.();
              (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit("sessions.changed", {
                agentId: "main",
                reason: "patch",
                session: {
                  ...incomingRow,
                  snapshotAt,
                  ...(changeOne
                    ? targetSurface === "activity"
                      ? {
                          activitySummary: {
                            state: "current",
                            text: updatedText,
                            updatedAt: snapshotAt,
                          },
                        }
                      : { label: updatedText }
                    : {}),
                },
                ancestorSessions: [],
              });
            },
            { row, stamp, changed, surface, text },
          );
          if (changed) {
            await page.locator(rowSelector).getByText(text, { exact: true }).waitFor();
          }
          await frames(page);
          return {
            ...(await rowEvidence(page)),
            changedSessionRows: changed ? 1 : 0,
            additionalListRequests: (await gateway.getRequests("sessions.list")).length - after,
          };
        },
      } satisfies Partial<EngineScenario>),
    );
  });

  const systemsPoll: EngineScenario = {
    ...systems,
    id: "noop-systems-pending-inventory-poll",
    explicitOnly: true,
    rowSelector: ".systems-machine",
    expected: "The native 15-second Systems tick refreshes unchanged pending-worker inventory.",
    fixtureOverrides: (sandbox, base) => {
      const fixture = systems.fixtureOverrides?.(sandbox, base) ?? {};
      const response = fixture.methodResponses?.["environments.list"];
      assert(response && typeof response === "object" && "environments" in response);
      assert(Array.isArray(response.environments));
      return {
        ...fixture,
        methodResponses: {
          ...fixture.methodResponses,
          "environments.list": {
            ...response,
            environments: [...response.environments, pendingWorker(0)],
          },
        },
      };
    },
    prepare: async (page, gateway) => {
      await systems.prepare(page, gateway);
      await retainRows(page, ".systems-machine");
    },
    run: async (page, gateway) => {
      const after = await gateway.deferNext("environments.list", { includeDesktopSetup: true });
      await waitForPoll(page, "environments.list", after, 15_000, {
        includeDesktopSetup: true,
      });
      await releasePoll(page, "environments.list");
      return { ...(await rowEvidence(page)), unchangedInventory: true, intervalMs: 15000 };
    },
  };

  const appearancePoll: EngineScenario = {
    ...appearance,
    id: "noop-appearance-system-info-poll",
    explicitOnly: true,
    expected:
      "The active Appearance data section receives unchanged host statistics after ten seconds.",
    fixtureOverrides: (sandbox, base) => {
      const fixture = appearance.fixtureOverrides?.(sandbox, base) ?? {};
      return {
        ...fixture,
        featureMethods: [...new Set([...(fixture.featureMethods ?? []), "system.info"])],
      };
    },
    prepare: async (page, gateway) => {
      await appearance.prepare(page, gateway);
      await page.locator("#settings-appearance-sidebar").scrollIntoViewIfNeeded();
      await gateway.waitForRequest("system.info");
      await settle(page);
    },
    run: async (page, gateway) => {
      const after = await gateway.deferNext("system.info");
      await waitForPoll(page, "system.info", after, 10_000);
      await releasePoll(page, "system.info");
      return { unchangedHostStatistics: true, intervalMs: 10000 };
    },
  };

  const telemetryPolls = (["gateway", "node"] as const).map((host): EngineScenario =>
    Object.assign({}, systems, {
      id: `noop-systems-${host}-telemetry-poll`,
      explicitOnly: true,
      rowSelector: ".systems-machine",
      expected: `The native 15-second Systems tick receives unchanged ${host} measurements and preserves unrelated inventory rows.`,
      prepare: async (page, gateway) => {
        await systems.prepare(page, gateway);
        const name = host === "gateway" ? "Parity workstation" : "Census node 1";
        await page
          .locator(".systems-machine")
          .filter({
            has: page.getByText(name, { exact: true }),
          })
          .click();
        await page.getByRole("heading", { name, exact: true }).waitFor();
        await settle(page);
        await retainRows(page, ".systems-machine");
      },
      run: async (page, gateway) => {
        const method = host === "gateway" ? "system.info" : "node.list";
        const after = await gateway.deferNext(method);
        await waitForPoll(page, method, after, 15_000);
        await releasePoll(page, method);
        return {
          ...(await rowEvidence(page)),
          unchangedMeasurements: true,
          intervalMs: 15000,
        };
      },
    } satisfies Partial<EngineScenario>),
  );

  const cloudPoll: EngineScenario = {
    ...cloudWorkers,
    id: "noop-cloud-workers-pending-inventory-poll",
    explicitOnly: true,
    rowSelector: ".cloud-environments__row",
    expected: "The native ten-second preparation poll receives the same 30 pending worker records.",
    fixtureOverrides: (sandbox, base) => {
      const fixture = cloudWorkers.fixtureOverrides?.(sandbox, base) ?? {};
      return {
        ...fixture,
        methodResponses: {
          ...fixture.methodResponses,
          "environments.list": {
            environments: Array.from({ length: 30 }, (_, index) => pendingWorker(index)),
            profiles: [],
          },
        },
      };
    },
    prepare: async (page) => {
      await waitForControlUiRoute(page, { routeId: "new-session" });
      await page.evaluate(() => window.openclawControlUi!.navigate("cloud-workers"));
      await waitForControlUiRoute(page, { routeId: "cloud-workers" });
      await page.waitForFunction(
        () => document.querySelectorAll(".cloud-environments__row").length === 30,
      );
      await settle(page);
      await retainRows(page, ".cloud-environments__row");
    },
    run: async (page, gateway) => {
      const match = { includePreparedDetails: true };
      const after = await gateway.deferNext("environments.list", match);
      await waitForPoll(page, "environments.list", after, 10_000, match);
      await releasePoll(page, "environments.list");
      return { ...(await rowEvidence(page)), unchangedWorkers: 30, intervalMs: 10000 };
    },
  };

  const skills = pageScenario("page-skill-settings-push");
  const skillsRefresh: EngineScenario = {
    ...skills,
    id: "noop-skills-inventory-refresh",
    rowSelector: ".skills-group .plugins-item",
    expected: "Refreshing the Skills inventory receives the same 1,000 installed skills.",
    prepare: async (page, gateway) => {
      await skills.prepare(page, gateway);
      await page
        .locator('.plugins-toolbar:has(input[name="skills-filter"])')
        .getByRole("button", { name: "Refresh", exact: true })
        .waitFor();
      await retainRows(page, ".skills-group .plugins-item");
    },
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("skills.status")).length;
      const refresh = page
        .locator('.plugins-toolbar:has(input[name="skills-filter"])')
        .getByRole("button", { name: "Refresh", exact: true });
      await refresh.click();
      await gateway.waitForRequest("skills.status", { after: before });
      await page
        .locator(
          '.plugins-toolbar:has(input[name="skills-filter"]) button[aria-label=Refresh]:enabled',
        )
        .waitFor();
      await settle(page);
      return { ...(await rowEvidence(page)), unchangedSkillInventory: true };
    },
  };

  const chat = interactionScenario("chat-typing");
  const board = interactionScenario("board-native-message-resources");
  const configSurfaces: {
    id: string;
    source: InteractionScenario;
    rowSelector: string;
  }[] = [
    {
      id: "usage",
      source: interactionScenario("data-usage-date-range"),
      rowSelector: ".session-bar-row",
    },
    { id: "logs", source: interactionScenario("data-logs-filter"), rowSelector: ".log-row" },
    { id: "chat", source: chat, rowSelector: ".chat-pane-cache__pane--active .chat-virtual-row" },
    {
      id: "new-session",
      source: {
        ...chat,
        route: "/new",
        prepare: async (page) => {
          await waitForControlUiRoute(page, { routeId: "new-session" });
          await page.locator("openclaw-new-session-page textarea").waitFor();
        },
      },
      rowSelector: "openclaw-new-session-page button, openclaw-new-session-page textarea",
    },
    {
      id: "dashboard",
      source: {
        ...board,
        route: controlUiSessionPath("agent:main:interaction-a", "", "dashboard"),
        prepare: async (page, gateway) => {
          await waitForControlUiRoute(page, { routeId: "dashboard" });
          await gateway.waitForRequest("board.get", {
            match: { sessionKey: "agent:main:interaction-a" },
          });
          await page.waitForFunction(
            () => document.querySelectorAll("openclaw-session-progress-widget").length === 6,
          );
          await board.run(page, gateway);
        },
      },
      rowSelector: "openclaw-session-progress-widget",
    },
  ];
  const configPushes = configSurfaces.map(({ id, source, rowSelector }): EngineScenario =>
    Object.assign({}, source, {
      id: `noop-${id}-config-push`,
      explicitOnly: true,
      initScript: documentProbe,
      rowSelector,
      expected: `An unchanged configuration receipt preserves the ${id} surface and its rows.`,
      prepare: async (page, gateway) => {
        await source.prepare(page, gateway);
        await settle(page);
        await retainRows(page, rowSelector);
      },
      run: async (page, gateway) => {
        const configBefore = (await gateway.getRequests("config.get")).length;
        const rosterBefore = (await gateway.getRequests("agents.list")).length;
        await page.evaluate(() => {
          window.openclawEngineMarkGatewayInput?.();
          (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit("config.changed", {});
        });
        await gateway.waitForRequest("config.get", { after: configBefore });
        await gateway.waitForRequest("agents.list", { after: rosterBefore });
        await settle(page);
        return { ...(await rowEvidence(page)), unchangedConfig: true };
      },
    } satisfies Partial<EngineScenario>),
  );

  const meetings = pageScenario("page-meetings-push");
  const meetingsPoll: EngineScenario = {
    ...meetings,
    id: "noop-meetings-equal-poll",
    rowSelector: ".transcripts-list__entry",
    expected:
      "The visible Meetings library's native three-second poll receives the same 100 entries.",
    prepare: async (page, gateway) => {
      await meetings.prepare(page, gateway);
      assert.equal(await page.evaluate(() => document.visibilityState), "visible");
      await retainRows(page, ".transcripts-list__entry");
    },
    run: async (page, gateway) => {
      const after = await gateway.deferNext("transcripts.list");
      await waitForPoll(page, "transcripts.list", after, 3_000);
      await releasePoll(page, "transcripts.list");
      return { ...(await rowEvidence(page)), unchangedMeetingLibrary: true, intervalMs: 3000 };
    },
  };

  const search = pageScenario("page-search-push");
  const searchRefresh: EngineScenario = {
    ...search,
    id: "noop-search-status-refresh",
    rowSelector: "openclaw-search-page .settings-row",
    expected:
      "Explicit Search refresh receives the same status and reuses its cached model catalog.",
    prepare: async (page, gateway) => {
      await search.prepare(page, gateway);
      await page
        .locator("openclaw-search-page")
        .getByRole("button", { name: "Refresh search status", exact: true })
        .waitFor();
      await retainRows(page, "openclaw-search-page .settings-row");
    },
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("webSearch.status")).length;
      const catalogs = (await gateway.getRequests("models.list")).length;
      await page
        .locator("openclaw-search-page")
        .getByRole("button", { name: "Refresh search status", exact: true })
        .click();
      await gateway.waitForRequest("webSearch.status", { after: before });
      await settle(page);
      return {
        ...(await rowEvidence(page)),
        unchangedSearchStatus: true,
        catalogRequests: (await gateway.getRequests("models.list")).length - catalogs,
      };
    },
  };

  const workboard = interactionScenario("workboard-events-cpu");
  const workboardPush: EngineScenario = {
    ...workboard,
    id: "noop-workboard-equal-push",
    explicitOnly: true,
    initScript: documentProbe,
    rowSelector: ".workboard-card",
    expected:
      "A duplicate native Workboard revision preserves all 1,000 cards without another list read.",
    prepare: async (page, gateway) => {
      await workboard.prepare(page, gateway);
      await settle(page);
      await retainRows(page, ".workboard-card");
    },
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("workboard.cards.list")).length;
      await page.evaluate(() => {
        window.openclawEngineMarkGatewayInput?.();
        // This is the revision accepted from the resource fixture's paginated list.
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit(
          "plugin.workboard.changed",
          {
            epoch: "synthetic-workboard-resources",
            revision: 1,
            cardsRevision: 1,
          },
        );
      });
      await settle(page);
      return {
        ...(await rowEvidence(page)),
        unchangedWorkboardRevision: true,
        cardListRequests: (await gateway.getRequests("workboard.cards.list")).length - before,
      };
    },
  };
  const workboardRefresh: EngineScenario = {
    ...workboardPush,
    id: "noop-workboard-equal-refresh",
    expected:
      "A newer Workboard invalidation reloads the same 1,000 cards through all ten held pages.",
    run: async (page, gateway) => {
      const responses = workboardResourceResponses(1_000, 2);
      await gateway.setMethodResponse("workboard.cards.list", responses["workboard.cards.list"]);
      const after = await gateway.deferNext("workboard.cards.list");
      await page.evaluate(() => {
        window.openclawEngineMarkGatewayInput?.();
        (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit(
          "plugin.workboard.changed",
          {
            epoch: "synthetic-workboard-resources",
            revision: 2,
            cardsRevision: 2,
          },
        );
      });
      await gateway.waitForRequest("workboard.cards.list", { after });
      await gateway.resolveDeferred("workboard.cards.list");
      await gateway.waitForRequest("workboard.cards.list", { after: after + 9 });
      await settle(page);
      assert.equal(await page.locator(".workboard-card").count(), 1_000);
      return {
        ...(await rowEvidence(page)),
        unchangedWorkboardCards: true,
        cardListRequests: (await gateway.getRequests("workboard.cards.list")).length - after,
      };
    },
  };

  return [
    ...sessions,
    systemsPoll,
    ...telemetryPolls,
    appearancePoll,
    cloudPoll,
    approvalPoll,
    questionPush,
    devicesPoll,
    profileRefresh,
    activityFallback,
    portalsPoll,
    skillsRefresh,
    ...configPushes,
    meetingsPoll,
    searchRefresh,
    workboardPush,
    workboardRefresh,
  ];
}
