import assert from "node:assert/strict";
import type { Page } from "playwright";
import type {
  EnvironmentSummary,
  PortalSummary,
  SkillWorkshopChange,
  SystemAgentChatResult,
  SystemChangeEntry,
  SystemChangesListResult,
} from "../../packages/gateway-protocol/src/index.ts";
import type {
  UserProfile,
  UsersPersonalFileGetResult,
} from "../../packages/gateway-protocol/src/schema/users.ts";
import type { loadVoiceWakeConfig } from "../../src/infra/voicewake.ts";
import type { ModelAuthStatusResult } from "../../ui/src/api/types.ts";
import {
  APP_ROUTE_IDS,
  pathForRoute,
  pathForPluginCatalogEntry,
  pathForTerminalSession,
  type RouteId,
} from "../../ui/src/app-route-paths.ts";
import type { ColdLoadRpcRecord } from "../../ui/src/test-helpers/control-ui-cold-load-probe-init.ts";
import { createColdLoadProbeInitScript } from "../../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiSessionPath,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  meetingEntry,
  meetingPage,
  meetingStatus,
} from "../../ui/src/test-helpers/transcripts.test-support.ts";
import { parityBaseScenario, parityWorkboardScenario } from "../control-ui-parity/fixtures.ts";
import { dataActivityScenarios } from "./control-ui-data-activity-scenarios.ts";
import { dataCatalogScenarios } from "./control-ui-data-catalog-scenarios.ts";
import {
  engineProbeInitScript,
  waitForEngineTranscript,
  type EngineScenario,
} from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { interactionScenarios } from "./control-ui-interaction-scenarios.ts";
import type {
  InteractionEvidence,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";
import { workboardResourceRoute } from "./control-ui-workboard-resource-fixture.ts";

type PageAction = {
  label: string;
  run: InteractionScenario["run"];
};
type NoChangeAction = PageAction & {
  kind: "push" | "refresh" | "poll" | "presence-push" | "model-push";
  prepare?: InteractionScenario["prepare"];
};
type PageDefinition = {
  ready: string;
  pathname?: string;
  rows?: { selector: string; minimum: number; totalSelector?: string };
  /** Keep the measurement open through incremental mounting, after first visibility. */
  completion?: { selector: string; minimum: number; maximum?: number }[];
  landed?: RouteId;
  search?: string;
  action?: PageAction;
  actionUnavailable?: string;
  source?: InteractionScenario;
};
type PageCoverage = {
  id: RouteId;
  path: string;
  status: "measured" | "redirect" | "excluded" | "unavailable";
  reason?: string;
  ready?: string;
  interaction?: string;
  interactionUnavailable?: string;
};

const time = 1_800_000_000_000;
const voiceWake: Awaited<ReturnType<typeof loadVoiceWakeConfig>> = {
  triggers: ["hey openclaw"],
};
const savedVoiceWake: Awaited<ReturnType<typeof loadVoiceWakeConfig>> = {
  triggers: ["hey openclaw", "census voice"],
};
const savedProfile: UserProfile = {
  id: "person-0",
  displayName: "Synthetic census profile",
  emails: ["person-0@example.invalid"],
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: time - 86_400_000,
  updatedAt: time,
};
export const enginePageFixtureCounts = {
  agents: 300,
  catalog: 1000,
  approvals: 200,
  worktrees: 300,
  workshop: 300,
  workshopChanges: 50,
  apps: 100,
  portals: 30,
  systems: 61,
  custodianChanges: 50,
  advancedRows: 303,
  advancedControls: 437,
};
const quantity = enginePageFixtureCounts;

type TerminalOutputSnapshot = {
  drawnAtMs: number;
  visibleAtMs: number;
  width: number;
  height: number;
};
declare global {
  interface Window {
    openclawEngineTerminalSelectionAtMs: number;
    openclawEngineTerminalOutput: {
      reset: () => void;
      read: () => TerminalOutputSnapshot | null;
    };
  }
}

/** Observe emitted bundles without replacing the terminal runtime or adding a product hook. */
function installTerminalOutputProbe() {
  const marker = "OpenClaw mock terminal";
  const entries = new Map<
    HTMLCanvasElement,
    { tail: string; drawnAtMs: number; visibleAtMs: number }
  >();
  // The wrapper below forwards each call with its original canvas receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (...args) {
    fillText.apply(this, args);
    const canvas = this.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.closest(".tp-host")) {
      return;
    }
    let entry = entries.get(canvas);
    if (!entry) {
      entry = { tail: "", drawnAtMs: 0, visibleAtMs: 0 };
      entries.set(canvas, entry);
    }
    if (entry.drawnAtMs) {
      return;
    }
    entry.tail = (entry.tail + args[0]).slice(-marker.length);
    if (entry.tail !== marker) {
      return;
    }
    entry.drawnAtMs = performance.now();
    const observed = entry;
    let visibleFrames = 0;
    const sample = () => {
      if (entries.get(canvas) !== observed || !canvas.isConnected) {
        return;
      }
      const visible =
        canvas.checkVisibility() &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        canvas.closest(".tp-viewport")?.getAttribute("aria-hidden") !== "true";
      visibleFrames = visible ? visibleFrames + 1 : 0;
      if (visibleFrames === 2) {
        observed.visibleAtMs = performance.now();
      } else {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  };
  window.openclawEngineTerminalOutput = {
    reset: () => entries.clear(),
    read: () => {
      for (const [canvas, entry] of entries) {
        if (entry.visibleAtMs && canvas.isConnected && canvas.checkVisibility()) {
          return {
            drawnAtMs: entry.drawnAtMs,
            visibleAtMs: entry.visibleAtMs,
            width: canvas.width,
            height: canvas.height,
          };
        }
      }
      return null;
    },
  };
}

async function waitForTerminalOutput(page: Page) {
  await page.waitForFunction(() => window.openclawEngineTerminalOutput.read() !== null);
  const output = await page.evaluate(() => window.openclawEngineTerminalOutput.read());
  assert(output, "Expected the mock banner drawn in a visible terminal canvas");
  return output;
}
const excluded: Partial<Record<RouteId, string>> = {
  chat: "Chat transcript is owned by the active transcript lane.",
  dashboard: "Board and Board tabs are owned by the active Board lane.",
  usage: "Usage is owned by the active Usage lane.",
  logs: "Logs is owned by #188617.",
  "new-session": "Boot and New Session are owned by the active boot/readiness lanes.",
};

function requiredScenario(scenarios: readonly InteractionScenario[], id: string) {
  const scenario = scenarios.find((entry) => entry.id === id);
  assert(scenario, `Missing reusable fixture scenario: ${id}`);
  return scenario;
}
const catalogSource = requiredScenario(dataCatalogScenarios, "data-plugins-filter");
const activitySource = requiredScenario(dataActivityScenarios, "data-activity-search");

function approvalHistory(offset: number) {
  return Array.from({ length: quantity.approvals / 2 }, (_, position) => {
    const index = position + offset;
    return {
      id: `census-approval-${index}`,
      status: "denied",
      presentation: {
        kind: "exec",
        commandText: `echo census-${index}`,
        allowedDecisions: ["deny"],
      },
      urlPath: `/approve/census-${index}`,
      createdAtMs: time - index * 1000,
      expiresAtMs: time + 60_000,
      resolvedAtMs: time - index * 1000,
      decision: "deny",
      reason: "user",
      source: { agentId: "main", sessionKey: "agent:main:census" },
      resolver: { kind: "device", id: "synthetic-device" },
    };
  });
}
function templateEntries() {
  return Array.from({ length: 24 }, (_, index) => ({
    packageName: `@synthetic/census-${index}`,
    displayName: `Census template ${index}`,
    summary: "A synthetic workflow template for the page census.",
    latestVersion: "1.0.0",
    channel: "community",
    official: false,
    ownerHandle: "synthetic",
    downloads: 100 + index,
    installs: 10 + index,
    updatedAtMs: time - index * 1000,
  }));
}

function fill(selector: string, value: string): PageAction {
  return {
    label: `Edit ${selector}`,
    run: async (page) => {
      const input = page.locator(selector).first();
      await input.fill(value);
      assert.equal(await input.inputValue(), value);
      await frames(page);
      return { edited: true };
    },
  };
}
function click(selector: string, outcome: string): PageAction {
  return {
    label: `Open ${outcome}`,
    run: async (page) => {
      assert.equal(await page.locator(outcome).filter({ visible: true }).count(), 0);
      await page.locator(selector).first().click();
      await page.locator(outcome).first().waitFor({ state: "visible" });
      await frames(page);
      return { opened: true };
    },
  };
}
function disclosure(selector: string): PageAction {
  return {
    label: `Expand ${selector}`,
    run: async (page) => {
      const details = page
        .locator(selector)
        .filter({ has: page.locator(":scope > summary:visible") })
        .first();
      const retained = await details.elementHandle();
      assert(retained, `Missing disclosure: ${selector}`);
      try {
        const before = await retained.evaluate((element) => element.hasAttribute("open"));
        await details.locator(":scope > summary").click();
        await frames(page);
        assert(
          await retained.evaluate((element) => element.isConnected && element.checkVisibility()),
        );
        assert.equal(await retained.evaluate((element) => element.hasAttribute("open")), !before);
        if (!before) {
          await page.waitForFunction(
            (element) =>
              [...element.children].some(
                (child) => child.tagName !== "SUMMARY" && child.checkVisibility(),
              ),
            retained,
          );
        }
        return { expanded: !before };
      } finally {
        await retained.dispose();
      }
    },
  };
}
const configPage = (): PageDefinition => ({
  ready: "openclaw-config-page .settings-page",
  action: {
    label: "Edit the first setting or expand its object",
    run: async (page, gateway) => {
      const scope = page.locator("openclaw-config-page");
      const checkbox = scope
        .locator('input[type="checkbox"]:enabled')
        .filter({ visible: true })
        .first();
      if (await checkbox.count()) {
        const checked = await checkbox.isChecked();
        await checkbox.setChecked(!checked);
        assert.equal(await checkbox.isChecked(), !checked);
        await frames(page);
        return { toggled: true };
      }
      const details = scope
        .locator("details")
        .filter({ has: page.locator(":scope > summary:visible") })
        .first();
      if (await details.count()) {
        return disclosure("openclaw-config-page details").run(page, gateway);
      }
      const input = scope
        .locator('input[type="text"]:enabled, input:not([type]):enabled, textarea:enabled')
        .filter({ visible: true })
        .first();
      if (await input.count()) {
        const before = await input.inputValue();
        await input.fill(before ? `${before} ` : "census");
        assert.notEqual(await input.inputValue(), before);
        await frames(page);
        return { edited: true };
      }
      const select = scope.locator("select:enabled").filter({ visible: true }).first();
      const option = select.locator("option:not(:checked):not(:disabled)").first();
      const value = await option.getAttribute("value");
      assert(value !== null, "Settings page has no interactive field");
      const label = (await option.textContent())?.trim();
      assert(label, "Settings option has no keyboard-selectable label");
      await select.pressSequentially(label);
      assert.equal(await select.inputValue(), value);
      await frames(page);
      return { selected: true };
    },
  },
});

const workboardCardMenu: PageAction = {
  label: "Hover a Workboard card and open its action menu",
  run: async (page) => {
    const menu = page.locator(".workboard-card__action-menu-panel:popover-open");
    assert.equal(await menu.count(), 0);
    const card = page.locator(".workboard-card").first();
    await card.hover();
    await card.locator(".workboard-card__menu-trigger").click();
    await menu.waitFor({ state: "visible" });
    await frames(page);
    return { opened: true };
  },
};

const definitions: Partial<Record<RouteId, PageDefinition>> = {
  settings: {
    ready: "openclaw-chat-page",
    landed: "chat",
    actionUnavailable: "Web /settings redirects to Chat; no separate page interaction.",
  },
  config: {
    ready: "openclaw-config-page .settings-page",
    landed: "appearance",
    actionUnavailable:
      "Retired General settings redirects to Appearance; interaction belongs to that destination.",
  },
  activity: {
    ready: ".activity-feed__session-title",
    source: activitySource,
    action: {
      label: "Search the 1,000-session inventory beyond the first page",
      run: activitySource.run,
    },
  },
  agents: {
    ready: "openclaw-agents-page .agent-identity-editor",
    completion: [{ selector: "openclaw-agents-page .agents-refresh-btn:enabled", minimum: 1 }],
    action: {
      label: "Refresh the agent roster, opening the phone action menu when needed",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("agents.list")).length;
        const button = page.locator(".agents-refresh-btn").filter({ visible: true }).first();
        if (await button.count()) {
          await button.click();
        } else {
          await page.locator(".agents-page-menu__trigger").click();
          await page
            .locator('[role="menu"]:popover-open')
            .getByRole("menuitem", { name: "Refresh", exact: true })
            .click();
        }
        await gateway.waitForRequest("agents.list", { after: before });
        await frames(page);
        await page.locator("openclaw-agents-page .agents-refresh-btn:enabled").waitFor({
          state: "attached",
        });
        assert.equal(await page.locator('.agents-toolbar [role="alert"]').count(), 0);
        return { refreshRequests: (await gateway.getRequests("agents.list")).length - before };
      },
    },
  },
  approvals: {
    ready: ".approval-history-table tbody tr, .approval-log > .approval-log__row",
    rows: {
      selector: ".approval-history-table tbody tr, .approval-log > .approval-log__row",
      minimum: 100,
    },
    action: {
      label: "Load the next 100 approval-history records",
      run: async (page) => {
        await page.locator('openclaw-approvals-page button:text-is("Load more")').click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              ".approval-history-table tbody tr, .approval-log > .approval-log__row",
            ).length === 200,
        );
        await frames(page);
        return { historyRows: 200 };
      },
    },
  },
  apps: {
    ready: "openclaw-apps-page .mcp-app-catalog__entry",
    rows: { selector: ".mcp-app-catalog__entry", minimum: 100 },
    action: {
      label:
        "Open an app conversation and complete its mock action; external resources are excluded",
      run: async (page, gateway) => {
        const match = { serverName: "census-app-0", toolName: "census_0" };
        const before = (await gateway.getRequests("mcp.app.launch", match)).length;
        await page.locator(".mcp-app-catalog__entry > button").first().click();
        await page.locator(".mcp-app-conversation").waitFor();
        await gateway.waitForRequest("mcp.app.launch", { after: before, match });
        await page
          .locator(".mcp-app-panel [role=status]")
          .getByText("App action completed.", { exact: true })
          .waitFor();
        assert.equal(new URL(page.url()).searchParams.get("server"), match.serverName);
        assert.equal(await page.locator(".mcp-app-panel [role=alert]").count(), 0);
        await frames(page);
        return { conversationOpened: true, appActionCompleted: true };
      },
    },
  },
  channels: {
    ready: "openclaw-channels-page .channels-item",
    action: click("openclaw-channels-page button.channels-item", ".channels-detail"),
  },
  "cloud-workers": {
    ready:
      'openclaw-cloud-workers-page .settings-empty a[href="https://docs.openclaw.ai/gateway/cloud-workers"]',
    action: {
      label: "Expand advanced cloud environment settings and edit a machine profile",
      run: async (page) => {
        const editor = page.locator(
          'openclaw-cloud-workers-page input[aria-label="Crabbox backend"]',
        );
        assert.equal(await editor.filter({ visible: true }).count(), 0);
        await page
          .locator("openclaw-cloud-workers-page summary")
          .filter({ hasText: "Advanced" })
          .click();
        await page.waitForFunction(
          () =>
            document.querySelectorAll('openclaw-cloud-workers-page button[aria-label^="Edit"]')
              .length === 30,
        );
        await page
          .locator('openclaw-cloud-workers-page button[aria-label^="Edit"]')
          .first()
          .click();
        await editor.waitFor({ state: "visible" });
        assert.equal(await editor.inputValue(), "aws");
        await frames(page);
        return { opened: true };
      },
    },
  },
  connection: {
    ready: "openclaw-connection-page .settings-page",
    action: {
      label: "Reveal the Gateway secret field",
      run: async (page) => {
        const toggle = page.locator(
          'openclaw-connection-page button[aria-label="Toggle secret visibility"]',
        );
        await toggle.click();
        await page
          .locator('openclaw-connection-page input[aria-label="Gateway secret"][type="text"]')
          .waitFor({ state: "visible" });
        await frames(page);
        return { opened: true };
      },
    },
  },
  custodian: {
    ready: "openclaw-custodian-page .custodian-surface",
    action: {
      label: "Open the 50-entry change history and present its final record",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("openclaw.changes.list")).length;
        await page.locator(".custodian__history-toggle").click();
        await gateway.waitForRequest("openclaw.changes.list", { after: before });
        await page.waitForFunction(
          (count) => document.querySelectorAll(".custodian__change-card").length === count,
          quantity.custodianChanges,
        );
        await page
          .locator(".custodian__change-summary")
          .getByText(`Updated synthetic setting ${quantity.custodianChanges - 1}`, { exact: true })
          .waitFor();
        assert.equal(await page.locator(".custodian__history-error").count(), 0);
        await frames(page);
        return { changeRecords: quantity.custodianChanges };
      },
    },
  },
  dashboards: {
    ready: "openclaw-dashboards-page .dashboard-card",
    action: {
      label: "Type a search to filter 200 dashboards to one match",
      run: async (page) => {
        // Native typing attributes expected result reflow to user input; fill() does not.
        await page
          .locator("openclaw-dashboards-page input[type=search]")
          .pressSequentially("Interaction 0995");
        await page.waitForFunction(() => {
          const cards = document.querySelectorAll(".dashboard-card[data-dashboard-session]");
          return (
            cards.length === 1 &&
            cards[0]?.getAttribute("data-dashboard-session") === "agent:main:interaction-995"
          );
        });
        await frames(page);
        return { matchingDashboards: 1 };
      },
    },
  },
  debug: {
    ready: "openclaw-debug-page textarea",
    action: {
      label: "Call node.list and render all 30 mock node results",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("node.list")).length;
        await page
          .locator('openclaw-debug-page select[aria-label="Method"]')
          .selectOption("node.list");
        await page.locator("openclaw-debug-page textarea").fill("{}");
        await page.locator('openclaw-debug-page button:text-is("Call")').click();
        await gateway.waitForRequest("node.list", { after: before });
        const result = page.locator('openclaw-debug-page pre[aria-label="node.list: OK"]');
        await result.waitFor({ state: "visible" });
        assert((await result.textContent())?.includes("census-node-29"));
        await frames(page);
        return { nodesReturned: 30 };
      },
    },
  },
  devices: {
    ready: "openclaw-devices-page .device-entry",
    action: {
      label: "Expand the first paired device and reveal its identity and actions",
      run: async (page) => {
        const row = page.locator("openclaw-devices-page details.device-entry").first();
        assert.equal(await row.getAttribute("open"), null);
        await row.locator(":scope > summary").click();
        await row.locator(".device-entry__body").waitFor({ state: "visible" });
        assert.equal(await row.getAttribute("open"), "");
        const deviceId = await row.getAttribute("data-device-id");
        assert(deviceId);
        assert((await row.locator(".device-fact__id").textContent())?.includes(deviceId));
        assert.equal(await row.locator(".device-fact__id button").isEnabled(), true);
        assert.equal(await row.locator(".device-entry__remove").isEnabled(), true);
        await frames(page);
        return { deviceExpanded: true, copyEnabled: true, removeEnabled: true };
      },
    },
  },
  labs: {
    ready: 'openclaw-labs-page input[role="switch"]:enabled',
    action: {
      label: "Enable Decision assistance and present the acknowledged setting",
      run: async (page, gateway) => {
        const control = page.locator('openclaw-labs-page input[role="switch"]').first();
        assert.equal(await control.isChecked(), false);
        const before = (await gateway.getRequests("config.patch")).length;
        await control.setChecked(true);
        const request = await gateway.waitForRequest("config.patch", { after: before });
        const params = request.params;
        assert(
          typeof params === "object" &&
            params !== null &&
            "raw" in params &&
            typeof params.raw === "string",
        );
        assert.deepEqual(JSON.parse(params.raw), {
          agents: { defaults: { experimental: { decisionAssistance: true } } },
        });
        await page.waitForFunction(() => {
          const input = document.querySelector<HTMLInputElement>(
            'openclaw-labs-page input[role="switch"]',
          );
          return input?.checked && input.getAttribute("aria-disabled") !== "true";
        });
        assert.equal(await page.locator("openclaw-labs-page [role=alert]").count(), 0);
        await frames(page);
        return { acknowledgedSetting: true };
      },
    },
  },
  lobsterdex: {
    ready: ".lobsterdex-page__card",
    action: {
      label: "Scroll to the final collectible",
      run: async (page) => {
        const card = page.locator(".lobsterdex-page__card").last();
        await card.scrollIntoViewIfNeeded();
        assert(await card.isVisible());
        await frames(page);
        return { cards: await page.locator(".lobsterdex-page__card").count() };
      },
    },
  },
  meetings: {
    ready: ".transcripts-list__entry",
    rows: { selector: ".transcripts-list__entry", minimum: 100 },
    action: {
      label: "Open a meeting from the 100-entry library",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("transcripts.get")).length;
        await page.locator(".transcripts-list__entry").first().click();
        await gateway.waitForRequest("transcripts.get", { after: before });
        await page
          .locator(".transcripts-reader__header")
          .getByText("Design review", { exact: true })
          .waitFor();
        await page
          .locator(".transcripts-reader")
          .getByText("Reader layout discussed.", { exact: true })
          .waitFor();
        return { openedMeeting: true };
      },
    },
  },
  "memory-import": {
    ready: ".memory-import__collection",
    rows: { selector: ".memory-import__collection", minimum: 10 },
    action: {
      label: "Review 10 memory files, then deselect their collection and present 90 selected items",
      run: async (page) => {
        const review = page.locator(".memory-import__collection details").first();
        assert.equal(await review.evaluate((element) => element.hasAttribute("open")), false);
        await review.locator("summary").click();
        await review.locator("li").last().waitFor({ state: "visible" });
        assert.equal(await review.locator("li").count(), 10);
        const control = page
          .locator('.memory-import__collection-choice input[type="checkbox"]')
          .first();
        assert.equal(await control.isChecked(), true);
        await control.setChecked(false);
        await page
          .locator(".memory-import .settings-row__title")
          .getByText("90 selected", { exact: true })
          .waitFor();
        assert.equal(await control.isChecked(), false);
        assert.equal(
          await page.locator('[data-test-id="memory-import-provider-button"]').isEnabled(),
          true,
        );
        await frames(page);
        return { selectedItems: 90, reviewedFiles: 10 };
      },
    },
  },
  "model-providers": {
    ready: ".provider-row[data-provider-id]",
    rows: { selector: ".provider-row[data-provider-id]", minimum: 3 },
    action: {
      label: "Filter model providers to OpenAI",
      run: async (page) => {
        const before = await page.locator(".provider-row[data-provider-id]").count();
        await page.locator('openclaw-model-providers-page input[type="search"]').fill("OpenAI");
        await page.waitForFunction((initialCount) => {
          const rows = [...document.querySelectorAll(".provider-row[data-provider-id]")];
          return (
            rows.length > 0 &&
            rows.length < initialCount &&
            rows.every((row) => row.getAttribute("data-provider-id")?.includes("openai"))
          );
        }, before);
        await frames(page);
        return { matchingProviders: await page.locator(".provider-row[data-provider-id]").count() };
      },
    },
  },
  "model-setup": {
    ready: 'openclaw-model-setup-page .model-setup__manual input[type="password"]',
    search: "?firstRun=1",
    action: fill(
      'openclaw-model-setup-page .model-setup__manual input[type="password"]',
      "census-placeholder",
    ),
    actionUnavailable:
      "The measured action edits the access value; provider activation and verification are excluded.",
  },
  plugins: {
    ready: "openclaw-plugins-page .plugin-catalog-card",
    source: requiredScenario(dataCatalogScenarios, "data-catalog-category-first-render"),
    action: {
      label: "Open the Tools catalog category",
      run: requiredScenario(dataCatalogScenarios, "data-catalog-category-first-render").run,
    },
  },
  "plugin-settings": {
    ready: "openclaw-plugins-page [data-plugin-id]",
    completion: [
      { selector: "openclaw-plugins-page [data-plugin-id]", minimum: quantity.catalog },
      {
        selector: '.plugins-settings-content .settings-group[aria-busy="true"]',
        minimum: 0,
        maximum: 0,
      },
    ],
    source: catalogSource,
    action: { label: "Filter 1,000 installed plugins", run: catalogSource.run },
  },
  portals: {
    ready: ".portals-rail__item",
    rows: { selector: ".portals-rail__item", minimum: 30 },
    action: {
      label: "Select the second portal in a read-only 30-portal inventory",
      run: async (page) => {
        const row = page.locator(".portals-rail__item").nth(1);
        await row.click();
        await page.waitForFunction(
          () =>
            document.querySelector('.portals-rail__item[aria-current="true"] .portals-rail__title')
              ?.textContent === "Census portal 1",
        );
        await page.getByText("Write access required", { exact: true }).waitFor();
        assert.equal(await page.locator("openclaw-portals-page iframe").count(), 0);
        await frames(page);
        return {
          selectedPortal: 1,
          portalCount: await page.locator(".portals-rail__item").count(),
        };
      },
    },
  },
  people: {
    ready: ".people-permissions details > summary",
    search: "?person=person-0",
    action: fill('.people-permissions input[type="search"]', "Synthetic"),
  },
  profile: {
    ready: 'openclaw-profile-page input[aria-label="Display name"]:enabled',
    action: {
      label: "Save the profile display name and present the acknowledged identity",
      run: async (page, gateway) => {
        const input = page.locator('openclaw-profile-page input[aria-label="Display name"]');
        const before = (await gateway.getRequests("users.setDisplayName")).length;
        const readsBefore = (await gateway.getRequests("users.self")).length;
        // Saving refreshes the authoritative profile after applying the write receipt.
        await gateway.setMethodResponse("users.self", { profile: savedProfile });
        await input.fill("Synthetic census profile");
        await input.press("Enter");
        await gateway.waitForRequest("users.setDisplayName", {
          after: before,
          match: { profileId: "person-0", displayName: "Synthetic census profile" },
        });
        await gateway.waitForRequest("users.self", { after: readsBefore });
        await page.waitForFunction(() => {
          const savedInput = document.querySelector<HTMLInputElement>(
            'openclaw-profile-page input[aria-label="Display name"]',
          );
          return (
            savedInput?.value === "Synthetic census profile" &&
            !savedInput.readOnly &&
            savedInput.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')
              ?.disabled
          );
        });
        await frames(page);
        return { identitySaved: true };
      },
    },
  },
  search: {
    ready: 'openclaw-search-page input[aria-label="Search query"]',
    action: {
      label: "Run a search health check and present its success",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("webSearch.test")).length;
        const input = page.locator('openclaw-search-page input[aria-label="Search query"]');
        await input.fill("Synthetic search census");
        await input.press("Enter");
        await gateway.waitForRequest("webSearch.test", { after: before });
        await page
          .locator("openclaw-search-page .search-test-status")
          .getByText("Search succeeded", { exact: true })
          .waitFor();
        await frames(page);
        return { searchTests: 1 };
      },
    },
  },
  secrets: {
    ready:
      "openclaw-secrets-page .secrets-store__table tbody tr, openclaw-secrets-page .secrets-store__list .secrets-store__row",
    rows: {
      selector:
        "openclaw-secrets-page .secrets-store__table tbody tr, openclaw-secrets-page .secrets-store__list .secrets-store__row",
      minimum: 200,
    },
    action: {
      label: "Open the first secret's row menu and edit its metadata",
      run: async (page) => {
        const row = page
          .locator(".secrets-store__table tbody tr, .secrets-store__list .secrets-store__row")
          .first();
        const name = (await row.locator(".secrets-store__name").textContent())?.trim();
        await row.locator(".secrets-store__menu-trigger").click();
        await page
          .locator('[role="menu"]:popover-open')
          .getByRole("menuitem", { name: "Edit", exact: true })
          .click();
        const dialog = page.locator("openclaw-secrets-page openclaw-modal-dialog");
        await dialog.locator('input[name="name"]').waitFor({ state: "visible" });
        assert.equal(await dialog.locator('input[name="name"]').inputValue(), name);
        assert.equal(await dialog.locator('textarea[name="value"]').inputValue(), "");
        await frames(page);
        return { editingSecret: true };
      },
    },
  },
  "skill-workshop": {
    ready: ".sw-row",
    rows: { selector: ".sw-row", minimum: 300 },
    action: {
      label: "Sort 300 workshop skills by name",
      run: async (page) => {
        const before = await page.locator(".sw-row").first().textContent();
        const select = page.locator(".sw-sort select");
        await select.press("n");
        assert.equal(await select.inputValue(), "name");
        await page.waitForFunction(() =>
          document.querySelector(".sw-row")?.textContent?.includes("census-0000"),
        );
        assert.notEqual(await page.locator(".sw-row").first().textContent(), before);
        await frames(page);
        return { skills: await page.locator(".sw-row").count() };
      },
    },
  },
  skills: {
    ready: ".skill-discovery [data-skill-id]",
    rows: {
      selector: ".skill-discovery [data-skill-id]",
      minimum: 1000,
      totalSelector: ".skill-discovery [aria-setsize]",
    },
    action: {
      label: "Filter discovered skills to one installed skill",
      run: async (page) => {
        await page.locator(".skill-discovery input[type=search]").fill("Data skill 0999");
        await page.waitForFunction(() => {
          const rows = document.querySelectorAll(".skill-discovery [data-skill-id]");
          return (
            rows.length === 1 && rows[0]?.getAttribute("data-skill-id") === "local:data-skill-0999"
          );
        });
        await frames(page);
        return { matchingSkills: 1 };
      },
    },
  },
  "skill-settings": {
    ready: ".skills-group .plugins-item",
    rows: { selector: ".skills-group .plugins-item", minimum: 1000 },
    action: {
      label: "Type a search to filter 1,000 installed skills to one match",
      run: async (page) => {
        await page.locator(".skills-toolbar__search input").pressSequentially("Data skill 0999");
        await page.waitForFunction(() => {
          const rows = document.querySelectorAll(".plugins-item--clickable");
          return rows.length === 1 && rows[0]?.textContent?.includes("Data skill 0999");
        });
        await frames(page);
        return { matchingSkills: 1 };
      },
    },
  },
  systems: {
    ready:
      '.systems-workspace button:is([aria-label="Machine details"], [aria-label="Device details"]):enabled',
    rows: { selector: ".systems-mobile-picker option:not(:disabled)", minimum: 61 },
    action: click(
      '.systems-workspace button:is([aria-label="Machine details"], [aria-label="Device details"])',
      ".systems-details",
    ),
  },
  terminal: {
    ready:
      "openclaw-terminal-page .tp-session-menu .tp-session, openclaw-terminal-page .tp-composer input",
    action: {
      label: "Create a terminal session from the root picker and submit input",
      run: async (page, gateway) => {
        const openedBefore = (await gateway.getRequests("terminal.open")).length;
        await page.locator('.tp-header button[aria-label="New terminal session"]').click();
        await gateway.waitForRequest("terminal.open", { after: openedBefore });
        const input = page.locator(".tp-composer input");
        await input.waitFor({ state: "visible" });
        const before = (await gateway.getRequests("terminal.input")).length;
        await input.fill("echo census");
        await input.press("Enter");
        await gateway.waitForRequest("terminal.input", { after: before });
        await page.waitForFunction(
          () => document.querySelector<HTMLInputElement>(".tp-composer input")?.value === "",
        );
        await frames(page);
        return { terminalCreated: true, inputSent: true };
      },
    },
  },
  worktrees: {
    ready: "openclaw-worktrees-page .settings-row__title",
    rows: { selector: "openclaw-worktrees-page .settings-row__title", minimum: 300 },
    action: click(
      "openclaw-worktrees-page button[aria-expanded]",
      'openclaw-worktrees-page input[aria-label="Repository"]',
    ),
  },
  workboard: {
    ready: ".workboard-card",
    action: workboardCardMenu,
  },
  plugin: {
    ready: ".workboard-card",
    search: "?plugin=workboard&id=workboard",
    action: workboardCardMenu,
  },
  templates: {
    ready: "[data-templates-entry]",
    action: {
      label: "Search templates and present the single matching card",
      run: async (page, gateway) => {
        const match = { query: "Census template 19" };
        const before = (await gateway.getRequests("templates.catalog.search", match)).length;
        await page.locator("[data-templates-search]").fill(match.query);
        await gateway.waitForRequest("templates.catalog.search", {
          after: before,
          match,
        });
        const results = page.locator('[data-catalog-section="results"]').filter({ visible: true });
        await results.getByRole("heading", { name: "Census template 19", exact: true }).waitFor();
        assert.equal(
          await results.locator("[data-templates-entry]").filter({ visible: true }).count(),
          1,
        );
        await frames(page);
        return { matchingTemplates: 1 };
      },
    },
  },
  about: {
    ready: "openclaw-about-page",
    actionUnavailable: "Informational page has no primary state-changing interaction.",
  },
  device: {
    ready: "openclaw-device-page",
    actionUnavailable:
      "Device permissions require the native host; browser capability presentation is measured.",
  },
  "device-permissions": {
    ready: "openclaw-device-permissions-page",
    actionUnavailable: "Native permission prompts are unavailable in headless browsers.",
  },
  communications: configPage(),
  appearance: configPage(),
  notifications: {
    ready: "openclaw-config-page .settings-page",
    actionUnavailable: "Web Push enrollment requires browser permission and a push subscription.",
  },
  security: configPage(),
  advanced: {
    ...configPage(),
    completion: [
      { selector: "openclaw-config-page .settings-row", minimum: quantity.advancedRows },
      { selector: 'openclaw-config-page [aria-busy="true"]', minimum: 0, maximum: 0 },
      {
        selector:
          "openclaw-config-page input, openclaw-config-page select, openclaw-config-page textarea, openclaw-config-page button",
        minimum: quantity.advancedControls,
      },
    ],
    action: disclosure("openclaw-config-page details.cfg-object:not([open])"),
  },
  automation: configPage(),
  mcp: {
    ready: "openclaw-mcp-servers-card .settings-section__actions > button:enabled",
    action: {
      label: "Open the MCP Add server form",
      run: async (page) => {
        const card = page.locator("openclaw-mcp-servers-card");
        await card.getByRole("button", { name: "Add server", exact: true }).click();
        const form = page.locator(".mcp-server-form");
        await form.locator('input[name="mcp-name"]:enabled').waitFor({ state: "visible" });
        await form.locator('input[name="mcp-target"]:enabled').waitFor({ state: "visible" });
        assert.equal(
          await form.locator('input[type="radio"][value="streamable-http"]').isChecked(),
          true,
        );
        await frames(page);
        return { addServerForm: true };
      },
    },
  },
  memory: {
    ready: ":is(.memory-overview__hero-copy, .memory-overview__status-copy) h2",
    action: {
      label: "Refresh the memory engine status",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("doctor.memory.status")).length;
        await page
          .locator(":is(.memory-overview__hero-actions, .memory-overview__status-action) button")
          .click();
        await gateway.waitForRequest("doctor.memory.status", {
          after: before,
          match: { agentId: "main" },
        });
        await page
          .locator(":is(.memory-overview__hero-copy, .memory-overview__status-copy) h2")
          .getByText("Memory is awake", { exact: true })
          .waitFor();
        assert.equal(
          await page
            .locator(".memory-overview__hero-error, .memory-overview__status-error")
            .count(),
          0,
        );
        await frames(page);
        return { statusRefreshed: true };
      },
    },
  },
  talk: {
    ready: 'openclaw-talk-settings textarea[aria-label="Trigger words"]',
    action: {
      label: "Edit voice wake triggers and present the saved acknowledgment",
      run: async (page, gateway) => {
        const input = page.locator('openclaw-talk-settings textarea[aria-label="Trigger words"]');
        const row = page
          .locator("openclaw-talk-settings .settings-row")
          .filter({ has: page.locator('textarea[aria-label="Trigger words"]') });
        const draft = "hey openclaw\n census voice ";
        const before = (await gateway.getRequests("voicewake.set")).length;
        await input.fill(draft);
        await gateway.waitForRequest("voicewake.set", {
          after: before,
          match: { triggers: draft.split("\n") },
        });
        await page.waitForFunction(
          (saved) =>
            document.querySelector<HTMLTextAreaElement>(
              'openclaw-talk-settings textarea[aria-label="Trigger words"]',
            )?.value === saved,
          savedVoiceWake.triggers.join("\n"),
        );
        await row.getByText("Saved", { exact: true }).waitFor({ state: "visible" });
        await frames(page);
        return { savedTriggers: savedVoiceWake.triggers.length };
      },
    },
  },
  infrastructure: configPage(),
  updates: configPage(),
  "ai-agents": {
    ...configPage(),
    completion: [{ selector: 'openclaw-config-page [aria-busy="true"]', minimum: 0, maximum: 0 }],
  },
  sessions: {
    ready: ".sessions-table .session-data-row",
    source: requiredScenario(interactionScenarios, "sessions-search"),
    action: {
      label: "Search 1,000 sessions and present the matching row",
      run: requiredScenario(interactionScenarios, "sessions-search").run,
    },
  },
  cron: {
    ready: ".cron-table__row",
    rows: {
      selector: ".cron-table__row",
      minimum: 50,
      totalSelector: ".cron-table__row[aria-setsize]",
    },
    source: requiredScenario(interactionScenarios, "cron-search"),
    action: {
      label: "Type a search to filter 500 automations to one match",
      run: requiredScenario(interactionScenarios, "cron-search-typing").run,
    },
  },
};

async function settleNoChangeAction(page: Page) {
  await page.waitForFunction(() => {
    const reads: { pendingMethods: string[]; queued: number } = Reflect.get(
      window,
      "__coldLoad",
    ).read();
    return reads.queued === 0 && reads.pendingMethods.length === 0;
  });
  await frames(page);
}

function unchangedPush(
  event: string,
  payload: unknown,
  method: string,
  kind: NoChangeAction["kind"] = "push",
): NoChangeAction {
  return {
    kind,
    label: `Deliver ${event}; ${method} returns its unchanged fixture payload`,
    run: async (page, gateway) => {
      const before = (await gateway.getRequests(method)).length;
      const rosterBefore =
        event === "config.changed" ? (await gateway.getRequests("agents.list")).length : null;
      await page.evaluate(
        ({ event: eventName, payload: eventPayload }) => {
          window.openclawEngineMarkGatewayInput?.();
          (window as MockGatewayWindow).openclawControlUiE2eGateway!.emit(eventName, eventPayload);
        },
        { event, payload },
      );
      await gateway.waitForRequest(method, { after: before });
      // Config delivery also owns a 100ms roster debounce; include its resulting publication.
      if (rosterBefore !== null) {
        await gateway.waitForRequest("agents.list", { after: rosterBefore });
      }
      await settleNoChangeAction(page);
      return {
        unchangedPayload: true,
        refreshRequests: (await gateway.getRequests(method)).length - before,
      };
    },
  };
}

const unchangedPresence = Array.from({ length: 30 }, (_, index) => ({
  instanceId: `census-node-${index}`,
  deviceId: `census-node-${index}`,
  host: `Census node ${index}`,
  platform: "linux",
  mode: "node",
  ts: time,
}));

/** Diagnostic-only actions: fresh transport values, unchanged domain contents. */
function noChangeActions(id: RouteId): NoChangeAction[] {
  const configPush = unchangedPush("config.changed", {}, "config.get");
  const actions: NoChangeAction[] = [configPush];
  if (id === "approvals") {
    actions[0] = unchangedPush(
      "exec.approval.resolved",
      { id: "census-approval-0", decision: "deny" },
      "approval.history",
    );
  } else if (id === "portals") {
    actions[0] = unchangedPush("portal.changed", {}, "portal.list");
  } else if (id === "apps") {
    actions[0] = unchangedPush("config.changed", {}, "mcp.app.discover");
  } else if (id === "profile" || id === "people") {
    actions[0] = unchangedPush(
      "sessions.changed",
      { reason: "profile-identity" },
      id === "people" ? "users.list" : "users.self",
    );
  }
  if (id === "devices" || id === "activity" || id === "agents" || id === "systems") {
    actions.push({
      kind: "presence-push",
      label: "Deliver the identical 30-node presence snapshot twice; measure the second delivery",
      prepare: async (page, gateway) => {
        await gateway.emitGatewayEvent("presence", { presence: unchangedPresence });
        await settleNoChangeAction(page);
      },
      run: async (page, gateway) => {
        await gateway.emitGatewayEvent("presence", { presence: unchangedPresence });
        await settleNoChangeAction(page);
        return { unchangedPresenceRows: unchangedPresence.length };
      },
    });
  }
  if (id === "devices") {
    actions.push(
      unchangedPush("node.hostStats", { nodeId: "census-node-0" }, "node.list", "refresh"),
    );
  }
  if (id === "model-providers" || id === "profile") {
    actions.push(
      unchangedPush(
        "chat.metadata.changed",
        { authChanged: true, modelCatalogChanged: true },
        id === "profile" ? "users.listModelAccounts" : "models.list",
        "model-push",
      ),
    );
  }
  if (id === "agents" || id === "memory") {
    const action = definitions[id]?.action;
    assert(action);
    actions.push({ ...action, kind: "refresh" });
  }
  if (id === "debug") {
    actions.push({
      kind: "refresh",
      label: "Refresh diagnostics with identical status, health, models, heartbeat and lane data",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("status")).length;
        await page.locator("openclaw-debug-page .debug-refresh:enabled").click();
        await gateway.waitForRequest("status", { after: before });
        await settleNoChangeAction(page);
        return { unchangedDiagnostics: true };
      },
    });
    actions.push({
      kind: "poll",
      label: "Wait for the real three-second diagnostics poll to return unchanged lane data",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("diagnostics.lanes")).length;
        await gateway.waitForRequest("diagnostics.lanes", { after: before });
        await settleNoChangeAction(page);
        return { unchangedDiagnostics: true, intervalMs: 3000 };
      },
    });
  }
  if (id === "connection") {
    actions.push({
      kind: "poll",
      label: "Wait for the real ten-second system-info poll to return its unchanged host snapshot",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("system.info")).length;
        await gateway.waitForRequest("system.info", { after: before });
        await settleNoChangeAction(page);
        return { unchangedHostSnapshot: true, intervalMs: 10000 };
      },
    });
  }
  return actions;
}

export const enginePageCoverage: readonly PageCoverage[] = APP_ROUTE_IDS.map((id) => {
  const definition = definitions[id];
  return {
    id,
    path: `${pathForRoute(id)}${definition?.search ?? ""}`,
    status: excluded[id] ? "excluded" : definition?.landed ? "redirect" : "measured",
    reason: excluded[id],
    ready: definition?.ready,
    interaction: definition?.action?.label,
    interactionUnavailable: definition?.actionUnavailable,
  };
});

function createPageFixture(
  definition: PageDefinition,
  id: RouteId,
): NonNullable<EngineScenario["fixtureOverrides"]> {
  return (sandbox, base) => {
    const catalog = catalogSource.fixtureOverrides?.(sandbox, base);
    const domain = definition.source?.fixtureOverrides?.(sandbox, base);
    const configResponse = catalog?.methodResponses?.["config.get"];
    const originalConfig =
      typeof configResponse === "object" && configResponse !== null && "config" in configResponse
        ? configResponse.config
        : {};
    const config = {
      ...(typeof originalConfig === "object" && originalConfig !== null ? originalConfig : {}),
      gateway: {
        controlUi: { experimental: { templates: true } },
        ...(id === "people"
          ? {
              roles: {
                default: "guest",
                definitions: {
                  guest: {
                    agents: ["main"],
                    sessions: { others: "view" },
                    sandbox: "required",
                    scopes: ["operator.sessions.read"],
                  },
                },
              },
            }
          : {}),
      },
      cloudWorkers: {
        profiles: Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [
            `worker-${index}`,
            { provider: "crabbox", settings: { provider: "aws", class: "standard" } },
          ]),
        ),
      },
    };
    const templates = templateEntries();
    const templateCategories = [
      "personal",
      "health",
      "travel",
      "productivity",
      "research",
      "engineering",
      "governance",
      "operations",
      "finance",
      "sales",
      "product",
      "people",
      "other",
    ];
    const environments: EnvironmentSummary[] = [
      {
        id: "gateway",
        type: "local",
        status: "available",
        label: "Census Gateway",
        platform: "linux",
        desktop: false,
      },
    ];
    if (id === "systems") {
      for (let index = 0; index < 30; index++) {
        environments.push({
          id: `node:census-node-${index}`,
          type: "node",
          status: index % 5 === 0 ? "unavailable" : "available",
          label: `Census node ${index}`,
          platform: "linux",
          desktop: false,
          sessionHost: true,
        });
        environments.push({
          id: `worker:census-${index}`,
          type: "worker",
          status: "available",
          label: `Census worker ${index}`,
          platform: "linux",
          desktop: false,
          worker: {
            providerId: "crabbox",
            profileId: `worker-${index}`,
            state: "ready",
            ageMs: 3_600_000,
            attachedSessionIds: [],
            tunnelStatus: "connected",
          },
        });
      }
    }
    const overrides = {
      ...parityBaseScenario,
      ...catalog,
      ...domain,
      sessions:
        domain?.sessions ??
        base.sessions.map((session, index) => ({ ...session, hasBoard: index % 5 === 0 })),
      ...(id === "portals" ? { operatorScopes: ["operator.read"] } : {}),
      terminalEnabled: true,
      featureMethods: [
        ...new Set([
          ...(parityBaseScenario.featureMethods ?? []),
          ...(catalog?.featureMethods ?? []),
          ...(domain?.featureMethods ?? []),
          "terminal.open",
          "terminal.input",
          "terminal.list",
          "terminal.attach",
          "terminal.resize",
          "terminal.close",
          "mcp.app.discover",
          "mcp.app.launch",
          "mcp.app.view",
          "skills.workshop.list",
          "skills.workshop.changes",
          "skills.workshop.read",
          "skills.search",
          "secrets.store.set",
          "users.setDisplayName",
          ...(id === "profile" ? ["users.personalFile.get"] : []),
          ...(id === "people" ? ["users.list", "config.get"] : []),
          "templates.catalog.search",
          "node.list",
          "device.pair.list",
          "environments.list",
          "worktrees.list",
          "approval.history",
          "exec.approval.grants.list",
          "transcripts.status",
          "transcripts.list",
          "transcripts.get",
          "migrations.memory.plan",
          "openclaw.changes.list",
          "webSearch.test",
          "openclaw.setup.detect",
          "portal.list",
          "voicewake.get",
          "voicewake.set",
        ]),
      ],
      methodResponses: {
        ...base.methodResponses,
        ...parityBaseScenario.methodResponses,
        ...catalog?.methodResponses,
        ...domain?.methodResponses,
        ...(id === "cron"
          ? {
              "cron.list": base.methodResponses?.["cron.list"],
              "cron.status": base.methodResponses?.["cron.status"],
            }
          : {}),
        ...(id === "profile"
          ? {
              "users.personalFile.get": {
                agentId: "main",
                profileId: savedProfile.id,
                content: "",
                hash: null,
                missing: true,
              } satisfies UsersPersonalFileGetResult,
            }
          : {}),
        ...(id === "people"
          ? {
              "users.list": {
                profiles: [
                  {
                    ...savedProfile,
                    role: "guest",
                    effectiveRole: "guest",
                    roleSource: "assigned",
                  },
                ],
              },
            }
          : {}),
        "config.get": {
          config,
          sourceConfig: config,
          ...(id === "people" ? { runtimeConfig: config } : {}),
          hash: "page-census",
          raw: JSON.stringify(config),
          valid: true,
          issues: [],
        },
        "config.schema": parityBaseScenario.methodResponses?.["config.schema"],
        ...(id === "labs"
          ? {
              "config.patch": {
                config: {
                  ...config,
                  agents: {
                    entries: { main: {} },
                    defaults: { experimental: { decisionAssistance: true } },
                  },
                },
                hash: "page-census-labs-saved",
              },
            }
          : {}),
        "users.setDisplayName": { profile: savedProfile },
        "mcp.app.launch": { toolResult: {} },
        "voicewake.get": voiceWake,
        "voicewake.set": savedVoiceWake,
        "approval.history": {
          cases: [
            { match: { cursor: "census-page-2" }, response: { items: approvalHistory(100) } },
            { response: { items: approvalHistory(0), nextCursor: "census-page-2" } },
          ],
        },
        "worktrees.list": {
          worktrees: Array.from({ length: quantity.worktrees }, (_, index) => ({
            id: `census-${index}`,
            name: `census-worktree-${index}`,
            repoFingerprint: "0123456789abcdef",
            repoRoot: "/synthetic/repo",
            path: `/synthetic/repo/worktrees/${index}`,
            branch: `task-${index}`,
            baseRef: "main",
            ownerKind: "manual",
            createdAt: time - index * 1000,
            lastActiveAt: time - index * 1000,
          })),
        },
        "skills.workshop.list": {
          agentId: "main",
          mode: "auto",
          root: "/synthetic/workshop",
          skills: Array.from({ length: quantity.workshop }, (_, index) => ({
            name: `census-${String(index).padStart(4, "0")}`,
            description: "Review source, preserve behavior, and verify the changed boundary.",
            updatedAtMs: time - index * 1000,
            sizeBytes: 900,
            files: ["SKILL.md"],
            useCount: index,
          })),
          archived: [],
        },
        "skills.workshop.changes": {
          changes: Array.from(
            { length: quantity.workshopChanges },
            (_, index): SkillWorkshopChange => ({
              id: `census-change-${index}`,
              agentId: "main",
              skillName: `census-${String(index).padStart(4, "0")}`,
              action: "patch",
              actor: "review",
              summary: "Clarified the source-review and verification steps.",
              versionId: `20261030T000000000Z-patch-${index}`,
              createdAtMs: time - index * 1000,
            }),
          ),
        },
        "skills.workshop.read": {
          content: "# Census skill\n\nReview source and verify behavior.\n",
          files: ["SKILL.md"],
        },
        "skills.search": { results: [] },
        "models.authStatus": {
          ts: time,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai:census", type: "oauth", status: "ok" }],
            },
            {
              provider: "anthropic",
              displayName: "Anthropic",
              status: "ok",
              profiles: [{ profileId: "anthropic:census", type: "oauth", status: "ok" }],
            },
            {
              provider: "google",
              displayName: "Google",
              status: "ok",
              profiles: [{ profileId: "google:census", type: "oauth", status: "ok" }],
            },
          ],
        } satisfies ModelAuthStatusResult,
        "webSearch.test": {
          provider: "parallel-free",
          latencyMs: 1,
          status: "ok",
          content: "Synthetic census search result",
          results: [
            {
              title: "Census source",
              url: "https://example.invalid/census",
              snippet: "Synthetic evidence",
            },
          ],
        },
        "openclaw.setup.detect": {
          candidates: [],
          unavailableCandidates: [],
          manualProviders: [{ id: "openai", label: "OpenAI" }],
          authOptions: [],
          prepareOptions: [],
          recommendedInstalls: [],
          workspace: "/synthetic/workspace",
          setupComplete: false,
        },
        "transcripts.status": meetingStatus,
        "transcripts.list": {
          sessions: Array.from({ length: 100 }, (_, index) =>
            index === 0
              ? meetingEntry
              : {
                  ...meetingEntry,
                  selector: `2026-08-27/census-${index}`,
                  sessionId: `census-${index}`,
                  title: `Census meeting ${index}`,
                },
          ),
          nextCursor: null,
        },
        "transcripts.get": meetingPage,
        "migrations.memory.plan": {
          agentId: "main",
          workspace: "/synthetic/workspace",
          providers: [
            {
              providerId: "claude",
              label: "Claude Code",
              found: true,
              source: "/synthetic/notes",
              target: "/synthetic/workspace/memory",
              confidence: "high",
              summary: {
                total: 100,
                planned: 100,
                migrated: 0,
                skipped: 0,
                conflicts: 0,
                errors: 0,
                sensitive: 0,
              },
              items: Array.from({ length: 100 }, (_, index) => ({
                id: `memory-${index}`,
                status: "planned",
                source: `/synthetic/notes/note-${index}.md`,
                target: `/synthetic/workspace/memory/note-${index}.md`,
                details: {
                  collectionId: `collection-${Math.floor(index / 10)}`,
                  collectionLabel: `Collection ${Math.floor(index / 10)}`,
                },
              })),
            },
          ],
        },
        "secrets.store.list": {
          entries: Array.from({ length: 200 }, (_, index) => ({
            name: `CENSUS_SERVICE_${index}_KEY`,
            scopeKind: "team",
            scopeId: "",
            kind: "secret",
            createdAtMs: time,
            updatedAtMs: time,
            allowedHosts: [`service-${index}.example.invalid`],
          })),
        },
        "mcp.app.discover": {
          servers: Array.from({ length: quantity.apps }, (_, index) => ({
            serverName: `census-app-${index}`,
            label: `Census application ${index}`,
            entrypoints: [
              {
                title: `Application ${index}`,
                toolName: `census_${index}`,
                resourceUri: `ui://census/${index}`,
                entrypoint: { type: "global" },
              },
            ],
          })),
        },
        "templates.catalog.search": {
          cases: [
            { match: { query: "Census template 19" }, response: { entries: [templates[19]] } },
            ...templateCategories.map((category, categoryIndex) => ({
              match: { category },
              response: {
                entries: templates.filter(
                  (_entry, index) => index % templateCategories.length === categoryIndex,
                ),
              },
            })),
            { response: { entries: templates.slice(0, 8) } },
          ],
        },
        "openclaw.changes.list": {
          entries: Array.from(
            { length: quantity.custodianChanges },
            (_, index): SystemChangeEntry => ({
              id: `census-change-${index}`,
              at: time - index * 60_000,
              kind: "config-write",
              source: "config-rpc",
              summary: `Updated synthetic setting ${index}`,
              changedPaths: [`census.setting${index}`],
            }),
          ),
        } satisfies SystemChangesListResult,
        "channels.status": {
          ts: time,
          channelOrder: ["telegram", "discord", "slack"],
          channelLabels: { telegram: "Telegram", discord: "Discord", slack: "Slack" },
          channels: {
            telegram: { configured: true, running: true },
            discord: { configured: true, running: true },
            slack: { configured: true, running: true },
          },
          channelAccounts: {},
          channelDefaultAccountId: {},
        },
        "node.list": {
          nodes: Array.from({ length: 30 }, (_, index) => ({
            nodeId: `census-node-${index}`,
            displayName: `Census node ${index}`,
            platform: "linux",
            version: "2026.10.30",
            connected: index % 5 !== 0,
            paired: true,
            caps: ["system"],
            commands: ["system.run"],
            connectedAtMs: time - 1000,
            hostStats: {
              cpuCount: 8,
              loadAverage: [1.5, 1.2, 1],
              memoryTotalBytes: 32 * 1024 ** 3,
              memoryFreeBytes: 12 * 1024 ** 3,
              diskTotalBytes: 1024 ** 4,
              diskAvailableBytes: 600 * 1024 ** 3,
              updatedAtMs: time,
            },
          })),
        },
        "device.pair.list": { pending: [], paired: [] },
        "portal.list": {
          portals: Array.from({ length: 30 }, (_, index): PortalSummary => ({
            id: `census-portal-${index}`,
            title: `Census portal ${index}`,
            port: 3000 + index,
            listenPort: 43000 + index,
            publicUrl: `https://portal-${index}.example.invalid/`,
            description: "Synthetic read-only portal inventory.",
            createdAtMs: time - index * 1000,
          })),
        },
        "environments.list": {
          environments,
          profiles: Array.from({ length: 30 }, (_, index) => ({
            id: `worker-${index}`,
            providerId: "crabbox",
            operatingSystems: [{ id: "ubuntu", label: "Ubuntu" }],
          })),
        },
      },
    };
    return id === "workboard"
      ? {
          ...overrides,
          ...parityWorkboardScenario,
          sessions: overrides.sessions,
          methodResponses: {
            ...overrides.methodResponses,
            ...parityWorkboardScenario.methodResponses,
          },
          featureMethods: [
            ...new Set([
              ...overrides.featureMethods,
              ...(parityWorkboardScenario.featureMethods ?? []),
            ]),
          ],
        }
      : overrides;
  };
}

async function navigate(page: Page, id: RouteId, search = "") {
  await page.evaluate(
    ({ id: routeId, pathname, search: routeSearch }) =>
      window.openclawControlUi!.navigate(routeId, { pathname, search: routeSearch }),
    { id, pathname: pathForRoute(id), search },
  );
}
async function ready(page: Page, id: RouteId, definition: PageDefinition) {
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
export async function collectEnginePageStructure(page: Page): Promise<InteractionEvidence> {
  return page
    .locator(".content")
    .first()
    .evaluate((readyElement) => {
      const root = readyElement.closest(".content") ?? readyElement;
      return {
        elements: root.querySelectorAll("*").length,
        rows: root.querySelectorAll(
          'tbody tr, [role="row"], .settings-row, .sw-row, .plugin-catalog-card, .activity-feed__session-row',
        ).length,
        inputs: root.querySelectorAll("input, select, textarea, button").length,
        closedDetailsElements: root.querySelectorAll("details:not([open]) *").length,
        closedDetailsInputs: root.querySelectorAll(
          "details:not([open]) input, details:not([open]) select, details:not([open]) textarea, details:not([open]) button",
        ).length,
      };
    });
}

async function measureVisit(
  page: Page,
  id: RouteId,
  definition: PageDefinition,
  timeoutMs = 60_000,
) {
  return page.evaluate(
    ({
      id: routeId,
      pathname,
      search: routeSearch,
      landed,
      selector,
      rows,
      completion,
      timeoutMs: limitMs,
    }) =>
      new Promise<{
        startedAtMs: number;
        readyMs: number;
        readyAtMs: number;
        contentReadyMs: number;
      }>((resolve, reject) => {
        const started = performance.now();
        let readyFrames = 0;
        let completeFrames = 0;
        let readyMs: number | undefined;
        let previousAnchorTop: number | undefined;
        const scrollport = document.getElementById("control-ui-main")!;
        const probe = () => {
          const snapshot = window.openclawControlUi?.snapshot();
          const route = snapshot?.route;
          const visible = [...document.querySelectorAll(selector)].some((target) =>
            target.checkVisibility(),
          );
          const rowsReady =
            !rows ||
            document.querySelectorAll(rows.selector).length >= rows.minimum ||
            Boolean(
              rows.totalSelector &&
              [...document.querySelectorAll(rows.totalSelector)].some(
                (row) => row.getAttribute("aria-setsize") === String(rows.minimum),
              ),
            );
          let cloudReadsReady = true;
          if (routeId === "cloud-workers") {
            const reads: { rpcs: ColdLoadRpcRecord[]; pendingMethods: string[]; queued: number } =
              Reflect.get(window, "__coldLoad").read();
            const completed = reads.rpcs.filter(
              (rpc) =>
                rpc.method === "environments.list" &&
                rpc.responseOk &&
                rpc.dispatchMs !== undefined,
            );
            cloudReadsReady =
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
              );
          }
          const pageReady =
            snapshot?.routeReady &&
            route?.status === "success" &&
            route.matches[0]?.routeId === landed &&
            route.pendingMatches.length === 0 &&
            visible &&
            rowsReady &&
            cloudReadsReady;
          readyFrames = pageReady ? readyFrames + 1 : 0;
          if (readyFrames >= 2) {
            readyMs ??= performance.now() - started;
          }
          // General redirects to the Language anchor. Controls can be ready
          // before its smooth scroll finishes. A busy frame can pause scrolling,
          // so require its destination as well as consecutive stable frames.
          const anchorTop =
            routeId === "config"
              ? document.getElementById("settings-language")?.getBoundingClientRect().top
              : undefined;
          // The floating phone header reserves the anchor's scroll destination.
          const scrollPaddingTop =
            anchorTop === undefined
              ? 0
              : Number.parseFloat(getComputedStyle(scrollport).scrollPaddingTop) || 0;
          const anchorSettled =
            routeId !== "config" ||
            (anchorTop !== undefined &&
              anchorTop >= -1 &&
              anchorTop < window.innerHeight &&
              (Math.abs(anchorTop - scrollport.getBoundingClientRect().top - scrollPaddingTop) <
                1 ||
                Math.abs(scrollport.scrollHeight - scrollport.clientHeight - scrollport.scrollTop) <
                  1) &&
              anchorTop === previousAnchorTop);
          previousAnchorTop = anchorTop;
          const contentReady =
            pageReady &&
            anchorSettled &&
            (!completion ||
              completion.every(({ selector: contentSelector, minimum, maximum }) => {
                const count = document.querySelectorAll(contentSelector).length;
                return count >= minimum && (maximum === undefined || count <= maximum);
              }));
          completeFrames = contentReady ? completeFrames + 1 : 0;
          if (readyMs !== undefined && completeFrames >= 2) {
            resolve({
              startedAtMs: started,
              readyMs,
              readyAtMs: started + readyMs,
              contentReadyMs: performance.now() - started,
            });
          } else if (performance.now() - started > limitMs) {
            reject(new Error(`Page readiness timed out: ${routeId} (${selector})`));
          } else {
            requestAnimationFrame(probe);
          }
        };
        window.openclawControlUi!.navigate(routeId, { pathname, search: routeSearch });
        requestAnimationFrame(probe);
      }),
    {
      id,
      pathname: definition.pathname ?? pathForRoute(id),
      search: definition.search ?? "",
      landed: definition.landed ?? id,
      selector: definition.ready,
      rows: definition.rows,
      completion: definition.completion,
      timeoutMs,
    },
  );
}

/** Recorded in the new document, so driver navigation and polling do not define readiness. */
function installColdPageReadiness(options: { routeId: RouteId; selector: string }) {
  const timing = { startedAtMs: 0, readyMs: 0, readyAtMs: 0, contentReadyMs: 0 };
  Reflect.set(window, "__engineColdPageReadiness", timing);
  let readyFrames = 0;
  const probe = () => {
    const snapshot = window.openclawControlUi?.snapshot();
    const route = snapshot?.route;
    const visible = [...document.querySelectorAll(options.selector)].some((target) =>
      target.checkVisibility(),
    );
    const pageReady =
      snapshot?.routeReady &&
      route?.status === "success" &&
      route.matches[0]?.routeId === options.routeId &&
      route.pendingMatches.length === 0 &&
      visible;
    readyFrames = pageReady ? readyFrames + 1 : 0;
    if (readyFrames >= 2) {
      // Performance time zero is this document's navigation start.
      timing.readyAtMs = performance.now();
      timing.readyMs = timing.readyAtMs;
      timing.contentReadyMs = timing.readyAtMs;
    } else {
      requestAnimationFrame(probe);
    }
  };
  requestAnimationFrame(probe);
}

/** One fresh context per phase preserves first-visit lazy imports and isolates local drafts. */
export function createEnginePageScenarios(
  gatewayLatencyMs = 0,
  pageOrigin: "new-session" | "chat" = "new-session",
  baseUrl?: string,
): readonly EngineScenario[] {
  const originSessionKey = "agent:main:interaction-a";
  const boot = async (page: Page) => {
    if (pageOrigin === "chat") {
      await waitForEngineTranscript(page);
    } else {
      await waitForControlUiRoute(page, { routeId: "new-session" });
    }
  };
  return enginePageCoverage.flatMap((coverage) => {
    if (coverage.status === "excluded" || coverage.status === "unavailable") {
      return [];
    }
    const definition = definitions[coverage.id];
    assert(definition, `Missing census definition for ${coverage.id}`);
    const id = coverage.id;
    const pageFixture = createPageFixture(definition, id);
    const common = {
      explicitOnly: true,
      route: pageOrigin === "chat" ? controlUiSessionPath(originSessionKey) : "/new",
      fixtureOverrides: ((sandbox, base) => {
        const fixture = pageFixture(sandbox, base);
        if (pageOrigin === "new-session") {
          return fixture;
        }
        // Keep the boot transcript when a route replaces the fixture's other sessions.
        return {
          ...fixture,
          sessionTranscripts: {
            ...fixture.sessionTranscripts,
            [originSessionKey]: base.sessionTranscripts![originSessionKey]!,
          },
        };
      }) satisfies NonNullable<EngineScenario["fixtureOverrides"]>,
      ...(pageOrigin === "chat"
        ? { initScript: engineProbeInitScript(false, gatewayLatencyMs) }
        : gatewayLatencyMs || id === "cloud-workers"
          ? {
              initScript: createColdLoadProbeInitScript({
                ownerProbes: false,
                sidebarCounters: false,
                latencyMs: gatewayLatencyMs,
                frameGapMs: 0,
                events: [],
              }),
            }
          : {}),
      ...(id === "workboard" || id === "plugin" ? { fixture: { workboardResources: true } } : {}),
      ...(definition.source?.createRequestHandlers
        ? { createRequestHandlers: definition.source.createRequestHandlers }
        : {}),
    };
    const enter = async (page: Page) => {
      await boot(page);
      await navigate(page, id, definition.search);
      await ready(page, id, definition);
    };
    const noChanges: EngineScenario[] = definition.landed
      ? []
      : noChangeActions(id).map((action) =>
          Object.assign({}, common, {
            id: `page-${id}-${action.kind}`,
            expected: action.label,
            initScript: createColdLoadProbeInitScript({
              ownerProbes: false,
              sidebarCounters: false,
              latencyMs: 0,
              frameGapMs: 0,
              events: [],
            }),
            // Successful, deterministic diagnostics keep the poll census on the data path.
            // The existing visit/action fixtures keep their original responses.
            fixtureOverrides: (sandbox, base) => {
              const fixture = common.fixtureOverrides?.(sandbox, base) ?? {};
              return id === "debug" || id === "connection"
                ? {
                    ...fixture,
                    featureMethods: [
                      ...new Set([
                        ...(fixture.featureMethods ?? []),
                        "diagnostics.lanes",
                        "system.info",
                      ]),
                    ],
                    methodResponses: {
                      ...fixture.methodResponses,
                      "last-heartbeat": { ts: time, status: "ok" },
                      "diagnostics.lanes": {
                        lanes: Array.from({ length: 30 }, (_, index) => ({
                          lane: `census-lane-${index}`,
                          activeCount: 0,
                          queuedCount: 0,
                          maxConcurrent: 4,
                        })),
                        dynamic: null,
                      },
                    },
                  }
                : fixture;
            },
            prepare: async (page, gateway) => {
              await enter(page);
              await settleNoChangeAction(page);
              await action.prepare?.(page, gateway);
            },
            run: async (page, gateway) => {
              const evidence = await action.run(page, gateway);
              await ready(page, id, definition);
              return evidence;
            },
          } satisfies Partial<EngineScenario>),
        );
    const visit: EngineScenario = {
      ...common,
      id: `page-${id}-visit`,
      expected: `First visit after ${pageOrigin} boot to ${coverage.path}; ${definition.ready} is visible, the route is settled, and all configured content counts are complete.`,
      prepare: boot,
      run: async (page) => {
        const timing = await measureVisit(page, id, definition);
        await ready(page, id, definition);
        return {
          visitStartedAtMs: timing.startedAtMs,
          visitReadyMs: timing.readyMs,
          visitReadyAtMs: timing.readyAtMs,
          contentReadyMs: timing.contentReadyMs,
        };
      },
    };
    const revisit: EngineScenario = {
      ...visit,
      id: `page-${id}-revisit`,
      expected: `Warm return to ${coverage.path} after its first visit.`,
      prepare: async (page) => {
        await enter(page);
        const destination = id === "about" ? "connection" : "about";
        await navigate(page, destination);
        await ready(page, destination, definitions[destination]!);
      },
    };
    const leave: EngineScenario = {
      ...common,
      id: `page-${id}-leave`,
      expected: `Leaving ${coverage.path} retires its presentation and settles the static About page (Connection when leaving About).`,
      prepare: enter,
      run: async (page) => {
        const destination = id === "about" ? "connection" : "about";
        const timing = await measureVisit(page, destination, definitions[destination]!);
        await frames(page);
        assert.equal(await page.locator(definition.ready).filter({ visible: true }).count(), 0);
        return { retired: true, leaveReadyMs: timing.readyMs };
      },
    };
    if (!definition.action) {
      return [visit, revisit, leave].concat(noChanges);
    }
    const action: EngineScenario = {
      ...common,
      id: `page-${id}-action`,
      expected: definition.action.label,
      prepare: async (page, gateway) => {
        await enter(page);
        await definition.source?.prepare(page, gateway);
      },
      run: async (page, gateway) => {
        const evidence = await definition.action!.run(page, gateway);
        return evidence;
      },
    };
    if (id === "plugins") {
      const browseSource = requiredScenario(
        dataCatalogScenarios,
        "data-catalog-inventory-readiness",
      );
      const browseFixture = createPageFixture({ ...definition, source: browseSource }, id);
      const browse: EngineScenario = {
        ...common,
        id: "page-plugins-browse-visit",
        expected: "Catalog is browsable and searchable before inventory grants installation.",
        fixtureOverrides: (sandbox, base) => {
          const fixture = browseFixture(sandbox, base);
          return pageOrigin === "chat"
            ? {
                ...fixture,
                sessionTranscripts: {
                  ...fixture.sessionTranscripts,
                  [originSessionKey]: base.sessionTranscripts![originSessionKey]!,
                },
              }
            : fixture;
        },
        prepare: boot,
        run: async (page, gateway) => {
          const timing = await measureVisit(page, id, definition);
          const evidence = await browseSource.run(page, gateway);
          assert(evidence && typeof evidence.inventoryReadyAtMs === "number");
          assert(typeof evidence.inputReadyAtMs === "number");
          return {
            ...evidence,
            visitStartedAtMs: timing.startedAtMs,
            visitReadyMs: timing.readyMs,
            visitReadyAtMs: timing.readyAtMs,
            inputReadyMs: evidence.inputReadyAtMs - timing.startedAtMs,
            contentReadyMs: evidence.inventoryReadyAtMs - timing.startedAtMs,
          };
        },
      };
      const detailPath = pathForPluginCatalogEntry("data-catalog-0900");
      const detail: EngineScenario = {
        ...browse,
        id: "page-plugins-detail-visit",
        expected:
          "Direct catalog detail shows its selected heading and README independently of inventory; installation waits for current inventory.",
        fixtureOverrides: (sandbox, base) => {
          // SAFETY: The sibling browse scenario defines this fixture above.
          const fixture = browse.fixtureOverrides!(sandbox, base);
          return {
            ...fixture,
            methodResponses: {
              ...fixture.methodResponses,
              "plugins.catalog.get": {
                plugin: {
                  id: "data-catalog-0900",
                  catalog: {
                    name: "Data plugin 0900",
                    summary: "Synthetic direct catalog detail",
                    official: false,
                    categories: ["tools"],
                    latestVersion: "1.0.0",
                  },
                  local: {
                    present: false,
                    installed: false,
                    enabled: false,
                    state: "not-installed",
                    action: "install",
                  },
                },
                detail: {
                  origin: "clawhub",
                  packageName: "@synthetic/data-plugin-0900",
                  topics: [],
                  configuration: [],
                  mcpServers: [],
                  skills: [],
                  versions: [],
                  readme:
                    "# Direct catalog evidence\n\nSynthetic README is ready independently of installed inventory.",
                },
              },
            },
          };
        },
        run: async (page, gateway) => {
          const timing = await page.evaluate(
            (pathname) =>
              new Promise<{
                visitStartedAtMs: number;
                visitReadyAtMs: number;
                visitReadyMs: number;
                installDisabledAtDetail: boolean;
                inventoryLoadingVisible: boolean;
              }>((resolve, reject) => {
                const started = performance.now();
                let readyFrames = 0;
                const probe = () => {
                  const heading = document.querySelector(".plugin-catalog-detail h1");
                  const readme = document.querySelector(".plugin-catalog-detail__readme");
                  const install = document.querySelector<HTMLButtonElement>(
                    ".plugin-catalog-detail__install",
                  );
                  // DOM readiness intentionally does not depend on the router's loader state.
                  const detailReady =
                    location.pathname === pathname &&
                    heading?.checkVisibility() &&
                    heading.textContent?.trim() === "Data plugin 0900" &&
                    readme?.checkVisibility() &&
                    readme.textContent?.includes(
                      "Synthetic README is ready independently of installed inventory.",
                    ) &&
                    install?.checkVisibility();
                  readyFrames = detailReady ? readyFrames + 1 : 0;
                  if (readyFrames >= 2 && install) {
                    const readyAt = performance.now();
                    resolve({
                      visitStartedAtMs: started,
                      visitReadyAtMs: readyAt,
                      visitReadyMs: readyAt - started,
                      installDisabledAtDetail: install.disabled,
                      inventoryLoadingVisible: [
                        ...document.querySelectorAll('#plugins-hub-panel > [role="status"]'),
                      ].some(
                        (element) =>
                          element.checkVisibility() &&
                          element.textContent?.includes("Loading plugins"),
                      ),
                    });
                  } else if (performance.now() - started > 60_000) {
                    reject(new Error("Selected catalog heading and README did not become visible"));
                  } else {
                    requestAnimationFrame(probe);
                  }
                };
                window.openclawControlUi!.navigate("plugins", { pathname });
                requestAnimationFrame(probe);
              }),
            detailPath,
          );
          await page.waitForFunction(() => {
            const install = document.querySelector<HTMLButtonElement>(
              ".plugin-catalog-detail__install",
            );
            return install?.checkVisibility() && !install.disabled;
          });
          assert.equal(
            await page.locator(".plugin-catalog-detail h1").textContent(),
            "Data plugin 0900",
          );
          assert.equal(new URL(page.url()).pathname, detailPath);
          assert(
            (await page.locator(".plugin-catalog-detail__readme").textContent())?.includes(
              "Synthetic README is ready independently of installed inventory.",
            ),
          );
          return {
            ...timing,
            contentReadyMs: timing.visitReadyMs,
            selectedDetailVisible: true,
            installEnabledAfterInventory: true,
            inventoryReadyMs:
              (await page.evaluate(() => performance.now())) - timing.visitStartedAtMs,
            catalogDetailRequests: (await gateway.getRequests("plugins.catalog.get")).length,
            inventoryRequests: (await gateway.getRequests("plugins.list")).length,
          };
        },
      };
      return [visit, revisit, action, leave, browse, detail].concat(noChanges);
    }
    if (id === "custodian") {
      const greetingDefinition: PageDefinition = {
        ...definition,
        ready:
          'openclaw-custodian-page .custodian__messages .chat-group.assistant .chat-text a[href="https://custodian-greeting.example.invalid/ready"]',
        completion: [{ selector: "openclaw-custodian-page textarea:not(:disabled)", minimum: 1 }],
      };
      const greeting: EngineScenario = {
        ...common,
        id: "page-custodian-greeting-visit",
        expected:
          "First Custodian visit renders its synthetic Markdown greeting and enabled composer after empty history.",
        prepare: boot,
        fixtureOverrides: (sandbox, base) => {
          const fixture = common.fixtureOverrides(sandbox, base);
          return {
            ...fixture,
            methodResponses: {
              ...fixture.methodResponses,
              "openclaw.chat.history": { turns: [] },
              "openclaw.chat": {
                sessionId: "census-custodian-greeting",
                reply:
                  "I am **ready** to help with this Gateway. [Census greeting](https://custodian-greeting.example.invalid/ready).",
                action: "none",
              } satisfies SystemAgentChatResult,
            },
          };
        },
        run: async (page) => {
          const timing = await measureVisit(page, id, greetingDefinition);
          await page
            .locator(".custodian__messages .chat-text strong")
            .getByText("ready", {
              exact: true,
            })
            .waitFor({ state: "visible" });
          return {
            visitStartedAtMs: timing.startedAtMs,
            visitReadyMs: timing.readyMs,
            visitReadyAtMs: timing.readyAtMs,
            contentReadyMs: timing.contentReadyMs,
            greetingVisible: true,
          };
        },
      };
      return [visit, greeting, revisit, action, leave].concat(noChanges);
    }
    if (id === "model-providers") {
      const marker = "Refreshed credential";
      const refresh: EngineScenario = {
        ...common,
        id: "page-model-providers-refresh",
        initScript: engineProbeInitScript(false, gatewayLatencyMs),
        expected:
          "Refresh current credentials: fresh auth rows become searchable independently of catalog completion; one auth and one catalog request complete.",
        prepare: async (page, gateway) => {
          await enter(page);
          await page.waitForFunction(() => {
            const reads: { pendingMethods: string[] } = Reflect.get(window, "__coldLoad").read();
            return !reads.pendingMethods.includes("models.list");
          });
          await gateway.setMethodResponse("models.authStatus", {
            ts: time + 1,
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                status: "ok",
                profiles: [
                  { profileId: "openai:census", type: "oauth", status: "ok", displayName: marker },
                ],
              },
            ],
          } satisfies ModelAuthStatusResult);
          assert.equal(await page.getByText(marker, { exact: true }).count(), 0);
        },
        run: async (page) => {
          const probe = await page.evaluateHandle((freshLabel) => {
            let started = 0;
            let requestOffset = 0;
            let readyMs: number | undefined;
            let readyFrames = 0;
            let frame = 0;
            const completion = Promise.withResolvers<{
              refreshReadyMs: number;
              catalogResponseMs: number;
              authRequests: number;
              catalogRequests: number;
              freshBeforeCatalog: boolean;
            }>();
            const dispose = () => {
              clearTimeout(timeout);
              cancelAnimationFrame(frame);
              document.removeEventListener("click", onRefreshClick, true);
            };
            const sample = () => {
              const row = document.querySelector(
                '.provider-row[data-provider-id="openai"] .provider-row__summary',
              );
              const input = document.querySelector<HTMLInputElement>(
                'openclaw-model-providers-page input[type="search"]',
              );
              const fresh = row?.checkVisibility() && row.textContent?.includes(freshLabel);
              readyFrames =
                fresh && input?.checkVisibility() && !input.disabled && !input.readOnly
                  ? readyFrames + 1
                  : 0;
              if (readyFrames >= 2) {
                readyMs ??= performance.now() - started;
              }
              const reads: { rpcs: ColdLoadRpcRecord[] } = Reflect.get(window, "__coldLoad").read();
              const catalog = reads.rpcs.find(
                (rpc) => rpc.method === "models.list" && rpc.requestMs >= started && rpc.responseOk,
              );
              if (readyMs !== undefined && catalog?.dispatchMs !== undefined) {
                const requests = (
                  window as MockGatewayWindow
                ).openclawControlUiE2eGateway!.requests.slice(requestOffset);
                const authRequests = requests.filter(
                  (rpc) => rpc.method === "models.authStatus",
                ).length;
                const catalogRequests = requests.filter(
                  (rpc) => rpc.method === "models.list",
                ).length;
                dispose();
                completion.resolve({
                  refreshReadyMs: readyMs,
                  catalogResponseMs: catalog.responseMs + catalog.dispatchMs - started,
                  authRequests,
                  catalogRequests,
                  freshBeforeCatalog: readyMs < catalog.responseMs + catalog.dispatchMs - started,
                });
              } else {
                frame = requestAnimationFrame(sample);
              }
            };
            const onRefreshClick = (event: Event) => {
              if (
                !(event.target instanceof Element) ||
                !event.target.closest(".model-providers__refresh-button")
              ) {
                return;
              }
              started = performance.now();
              requestOffset = (window as MockGatewayWindow).openclawControlUiE2eGateway!.requests
                .length;
              frame = requestAnimationFrame(sample);
            };
            const timeout = setTimeout(() => {
              dispose();
              completion.reject(new Error("Fresh Models credentials or catalog did not settle"));
            }, 60_000);
            document.addEventListener("click", onRefreshClick, { capture: true });
            return { completion: completion.promise, dispose };
          }, marker);
          try {
            await page.locator(".model-providers__refresh-button").click();
            const evidence = await probe.evaluate((state) => state.completion);
            assert.equal(evidence.authRequests, 1);
            assert.equal(evidence.catalogRequests, 1);
            await page.locator('openclaw-model-providers-page input[type="search"]').fill("OpenAI");
            await page.getByText(marker, { exact: true }).waitFor({ state: "visible" });
            return evidence;
          } finally {
            await probe.evaluate((state) => state.dispose());
            await probe.dispose();
          }
        },
      };
      return [visit, revisit, action, leave, refresh].concat(noChanges);
    }
    if (id === "skill-settings") {
      const inputVisit: EngineScenario = {
        ...common,
        initScript:
          common.initScript ??
          createColdLoadProbeInitScript({
            ownerProbes: false,
            sidebarCounters: false,
            latencyMs: gatewayLatencyMs,
            frameGapMs: 0,
            events: [],
          }),
        id: "page-skill-settings-input-visit",
        expected:
          "First visit to Skills settings accepts a filter while installed inventory loads.",
        prepare: boot,
        run: async (page) => {
          const selector = 'input[name="skills-filter"]:enabled';
          assert(definition.rows, "Skills settings must define full inventory readiness");
          const timingRead = measureVisit(page, id, {
            ...definition,
            ready: selector,
            rows: undefined,
            completion: [definition.rows, ...(definition.completion ?? [])],
          });
          void timingRead.catch(() => undefined);
          const readyAt = await page.waitForFunction(
            (inputSelector) => {
              const input = document.querySelector<HTMLInputElement>(inputSelector);
              return input?.checkVisibility() && !input.disabled ? performance.now() : false;
            },
            selector,
            { polling: "raf" },
          );
          const inputReadyAtMs = await readyAt.jsonValue();
          await readyAt.dispose();
          assert(typeof inputReadyAtMs === "number");
          const search = page.locator(selector);
          await search.fill("Data skill");
          assert.equal(await search.inputValue(), "Data skill");
          const input = await page.evaluate(() => {
            const reads: { pendingMethods: string[] } = Reflect.get(window, "__coldLoad").read();
            return {
              acceptedAtMs: performance.now(),
              query: document.querySelector<HTMLInputElement>('input[name="skills-filter"]')?.value,
              inventoryPending: reads.pendingMethods.includes("skills.status"),
              visiblyBusy:
                document
                  .querySelector(".plugins-toolbar .refresh-button")
                  ?.getAttribute("aria-busy") === "true",
              loadingMessage: [...document.querySelectorAll(".settings-empty")].some(
                (element) => element.textContent?.trim() === "Loading…",
              ),
            };
          });
          assert.equal(input.query, "Data skill");
          if (input.inventoryPending) {
            assert.equal(input.visiblyBusy, true);
            assert.equal(input.loadingMessage, true);
          }
          const timing = await timingRead;
          assert.equal(await search.inputValue(), "Data skill");
          return {
            visitStartedAtMs: timing.startedAtMs,
            visitReadyMs: inputReadyAtMs - timing.startedAtMs,
            visitReadyAtMs: inputReadyAtMs,
            inputFrameReadyMs: timing.readyMs,
            contentReadyMs: timing.contentReadyMs,
            inputAcceptedMs: input.acceptedAtMs - timing.startedAtMs,
            inventoryPendingAtInput: input.inventoryPending,
            inventoryBusyAtInput: input.visiblyBusy,
            searchAccepted: true,
          };
        },
      };
      return [visit, revisit, action, leave, inputVisit].concat(noChanges);
    }
    if (id === "search") {
      const firstAdvancedOpen: EngineScenario = {
        ...common,
        id: "page-search-advanced-open",
        expected: "First opening of Search Advanced settings presents the config fields.",
        prepare: enter,
        run: async (page) => {
          const advanced = page.locator(".config-advanced-disclosure");
          const fields = advanced.locator(":scope > .settings-row--stacked-on-narrow");
          const inputs = advanced.locator("input, select, textarea, button");
          assert.equal(await advanced.getAttribute("open"), null);
          const mountedFieldsBefore = await fields.count();
          await advanced.locator(":scope > summary").click();
          await page.waitForFunction(() => {
            const details = document.querySelector<HTMLDetailsElement>(
              ".config-advanced-disclosure",
            );
            return details?.open && details.querySelectorAll("input, select, textarea").length > 0;
          });
          await frames(page);
          const mounted = { fields: await fields.count(), inputs: await inputs.count() };
          // Native-search object leaves now have their own rows alongside the three numbers.
          assert.deepEqual(mounted, { fields: 11, inputs: 14 });
          return {
            opened: true,
            mountedFieldsBefore,
            mountedFields: mounted.fields,
            mountedInputs: mounted.inputs,
          };
        },
      };
      return [visit, revisit, action, leave, firstAdvancedOpen].concat(noChanges);
    }
    if (id === "terminal") {
      const outputCommon = {
        ...common,
        setup: async (page: Page) => {
          await page.addInitScript(installTerminalOutputProbe);
        },
      };
      const firstCreateDefinition: PageDefinition = {
        ...definition,
        ready: "openclaw-terminal-page .tp-session-menu .tp-session.is-current",
      };
      const setupSelectionTiming = async (page: Page) => {
        await outputCommon.setup(page);
        await page.addInitScript((selector) => {
          window.openclawEngineTerminalSelectionAtMs = 0;
          document.addEventListener(
            "click",
            (event) => {
              if (
                event.isTrusted &&
                event.target instanceof Element &&
                event.target.closest(selector)
              ) {
                window.openclawEngineTerminalSelectionAtMs = performance.now();
              }
            },
            { capture: true, passive: true },
          );
        }, firstCreateDefinition.ready);
      };
      const outputEvidence = async (page: Page, target: PageDefinition) => {
        await page.evaluate(() => window.openclawEngineTerminalOutput.reset());
        const timing = await measureVisit(page, "terminal", target);
        // Generic Terminal opens its first shell behind the Sessions picker.
        // Select that shell; the + action would create a second one instead.
        if (!target.pathname) {
          await page.locator(firstCreateDefinition.ready).click();
        }
        const output = await waitForTerminalOutput(page);
        assert(output.visibleAtMs >= timing.startedAtMs);
        const pickerSelectedAtMs = target.pathname
          ? null
          : await page.evaluate(() => window.openclawEngineTerminalSelectionAtMs);
        if (pickerSelectedAtMs !== null) {
          assert(
            pickerSelectedAtMs >= timing.startedAtMs && pickerSelectedAtMs <= output.visibleAtMs,
          );
        }
        await page.locator("openclaw-terminal-page .tp-composer input").waitFor();
        const readyAtMs = Math.max(timing.readyAtMs, output.visibleAtMs);
        return {
          visitStartedAtMs: timing.startedAtMs,
          routeControlsReadyMs: timing.readyMs,
          visitReadyMs: readyAtMs - timing.startedAtMs,
          visitReadyAtMs: readyAtMs,
          firstOutputDrawMs: output.drawnAtMs - timing.startedAtMs,
          firstOutputVisibleMs: output.visibleAtMs - timing.startedAtMs,
          ...(pickerSelectedAtMs === null
            ? {}
            : { pickerSelectionToOutputMs: output.visibleAtMs - pickerSelectedAtMs }),
          canvasWidth: output.width,
          canvasHeight: output.height,
          syntheticTerminal: true,
        };
      };
      const firstCreate: EngineScenario = {
        ...outputCommon,
        id: "page-terminal-first-create-visit",
        setup: setupSelectionTiming,
        expected:
          "From a settled origin, the first Terminal visit creates exactly one shell and reveals its rendered synthetic banner.",
        prepare: boot,
        run: async (page, gateway) => {
          assert.equal((await gateway.getRequests("terminal.open")).length, 0);
          const evidence = await outputEvidence(page, firstCreateDefinition);
          assert.equal((await gateway.getRequests("terminal.open")).length, 1);
          assert.equal((await gateway.getRequests("terminal.attach")).length, 0);
          return { ...evidence, openedSessions: 1, attachedSessions: 0 };
        },
      };
      const attachedSession = {
        sessionId: "engine-detached-terminal",
        agentId: "main",
        shell: "/bin/zsh",
        cwd: "/workspace/openclaw",
        confined: false,
      };
      const firstAttach: EngineScenario = {
        ...outputCommon,
        id: "page-terminal-first-attach-visit",
        expected:
          "From a settled origin, the first Terminal visit attaches one existing synthetic shell and renders its replay, without creating a new shell.",
        fixtureOverrides: (sandbox, base) => {
          const fixture = common.fixtureOverrides(sandbox, base);
          const buffer = "OpenClaw mock terminal\r\nRestored synthetic shell output.\r\n$ ";
          return {
            ...fixture,
            methodResponses: {
              ...fixture.methodResponses,
              "terminal.list": {
                sessions: [{ ...attachedSession, attached: false, createdAtMs: time }],
              },
              "terminal.attach": { ...attachedSession, buffer, seq: buffer.length },
            },
          };
        },
        prepare: boot,
        run: async (page, gateway) => {
          const evidence = await outputEvidence(page, {
            ...definition,
            pathname: pathForTerminalSession(attachedSession.sessionId),
            ready: "openclaw-terminal-page .tp-composer input",
          });
          assert.equal((await gateway.getRequests("terminal.open")).length, 0);
          const attaches = await gateway.getRequests("terminal.attach");
          assert.equal(attaches.length, 1);
          assert.deepEqual(attaches[0]!.params, { sessionId: attachedSession.sessionId });
          return { ...evidence, openedSessions: 0, attachedSessions: 1 };
        },
      };
      const outputRevisit: EngineScenario = {
        ...outputCommon,
        id: "page-terminal-first-output-revisit",
        setup: setupSelectionTiming,
        expected:
          "Return from settled About to the first shell's rendered replay without opening another shell.",
        prepare: async (page, gateway) => {
          await boot(page);
          await firstCreate.run(page, gateway);
          await navigate(page, "about");
          await ready(page, "about", definitions.about!);
          // The runner settles native route preloads, network idle and fonts after prepare.
        },
        run: async (page, gateway) => {
          const openedBefore = (await gateway.getRequests("terminal.open")).length;
          const attachedBefore = (await gateway.getRequests("terminal.attach")).length;
          const evidence = await outputEvidence(page, firstCreateDefinition);
          assert.equal((await gateway.getRequests("terminal.open")).length, openedBefore);
          assert.equal((await gateway.getRequests("terminal.attach")).length, attachedBefore + 1);
          return { ...evidence, openedSessions: 0, attachedSessions: 1 };
        },
      };
      const coldVisits: EngineScenario[] = baseUrl
        ? [
            { source: firstCreate, attach: false, target: firstCreateDefinition },
            {
              source: firstAttach,
              attach: true,
              target: {
                ...definition,
                pathname: pathForTerminalSession(attachedSession.sessionId),
                ready: "openclaw-terminal-page .tp-composer input",
              },
            },
          ].map(({ source, attach, target }): EngineScenario =>
            Object.assign({}, source, {
              id: attach ? "page-terminal-cold-attach-visit" : "page-terminal-cold-visit",
              route: target.pathname ?? pathForRoute("terminal"),
              navigation: "measured",
              setup: async (page) => {
                if (attach) {
                  await page.addInitScript(installTerminalOutputProbe);
                }
              },
              expected: attach
                ? "A fresh document attaches one existing synthetic shell and renders its replay in a visible canvas."
                : "A fresh document opens Terminal directly and settles its first-shell Sessions picker for two consecutive frames.",
              initScript: `${createColdLoadProbeInitScript({
                ownerProbes: false,
                sidebarCounters: false,
                latencyMs: gatewayLatencyMs,
                frameGapMs: 0,
                events: [],
              })}
;if (window === window.top && location.protocol !== "about:") {
  (() => { const __name = (fn) => fn;
    (${installColdPageReadiness.toString()})(${JSON.stringify({ routeId: id, selector: target.ready })});
  })();
}`,
              prepare: async () => {},
              run: async (page, gateway) => {
                await page.goto(
                  new URL(target.pathname ?? pathForRoute("terminal"), baseUrl).href,
                  {
                    waitUntil: "domcontentloaded",
                  },
                );
                await page.waitForFunction(
                  () => Reflect.get(window, "__engineColdPageReadiness")?.readyAtMs > 0,
                );
                const timing: { readyAtMs: number } = await page.evaluate(() =>
                  Reflect.get(window, "__engineColdPageReadiness"),
                );
                const output = attach ? await waitForTerminalOutput(page) : null;
                const readyAtMs = Math.max(timing.readyAtMs, output?.visibleAtMs ?? 0);
                assert.equal((await gateway.getRequests("terminal.open")).length, attach ? 0 : 1);
                const attaches = await gateway.getRequests("terminal.attach");
                assert.equal(attaches.length, attach ? 1 : 0);
                if (attach) {
                  assert.deepEqual(attaches[0]!.params, { sessionId: attachedSession.sessionId });
                }
                return {
                  visitStartedAtMs: 0,
                  routeControlsReadyMs: timing.readyAtMs,
                  visitReadyMs: readyAtMs,
                  visitReadyAtMs: readyAtMs,
                  ...(output
                    ? {
                        firstOutputDrawMs: output.drawnAtMs,
                        firstOutputVisibleMs: output.visibleAtMs,
                      }
                    : {}),
                  openedSessions: attach ? 0 : 1,
                  attachedSessions: attach ? 1 : 0,
                  syntheticTerminal: true,
                };
              },
            } satisfies Partial<EngineScenario>),
          )
        : [];
      const composerInput: EngineScenario = {
        ...common,
        id: "page-terminal-composer-input",
        expected: "Type ten characters and submit through an already running terminal composer.",
        prepare: async (page, gateway) => {
          await enter(page);
          await definition.action!.run(page, gateway);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await frames(page);
        },
        run: async (page, gateway) => {
          const command = "echo warm0";
          const input = page.locator("openclaw-terminal-page .tp-composer input");
          assert.equal(await input.inputValue(), "");
          const openedBefore = (await gateway.getRequests("terminal.open")).length;
          const commandMatch = { data: command };
          const enterMatch = { data: "\r" };
          const commandBefore = (await gateway.getRequests("terminal.input", commandMatch)).length;
          const enterBefore = (await gateway.getRequests("terminal.input", enterMatch)).length;
          await input.pressSequentially(command);
          await input.press("Enter");
          await gateway.waitForRequest("terminal.input", {
            after: commandBefore,
            match: commandMatch,
          });
          await gateway.waitForRequest("terminal.input", { after: enterBefore, match: enterMatch });
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLInputElement>("openclaw-terminal-page .tp-composer input")
                ?.value === "",
          );
          await frames(page);
          assert.equal((await gateway.getRequests("terminal.open")).length, openedBefore);
          return { typedCharacters: command.length, inputSent: true };
        },
      };
      return [
        visit,
        revisit,
        action,
        leave,
        composerInput,
        firstCreate,
        firstAttach,
        outputRevisit,
        ...coldVisits,
      ].concat(noChanges);
    }
    return [visit, revisit, action, leave].concat(noChanges);
  });
}

export type EngineRouteTransition = { from: RouteId; to: RouteId; path: string };
export type EngineRouteTransitionCallback = (
  page: Page,
  transition: EngineRouteTransition,
  run: () => Promise<number>,
) => Promise<void>;

const transitionDefinitions: Partial<Record<RouteId, PageDefinition>> = {
  ...definitions,
  "new-session": {
    ready: "openclaw-new-session-page .agent-chat__composer-combobox textarea",
  },
  chat: {
    ready: ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
    pathname: controlUiSessionPath("agent:main:interaction-a"),
  },
  dashboard: {
    ready: "openclaw-chat-page .sidebar-region",
    pathname: controlUiSessionPath("agent:main:interaction-a").replace(/^\/chat/, "/dashboard"),
  },
  logs: { ready: "openclaw-logs-page .logs-toolbar" },
  usage: { ready: "openclaw-usage-page .usage-page" },
  workboard: {
    ready: ".workboard-card",
    pathname: workboardResourceRoute,
    // The resource fixture loads 100 cards; windowing mounts only visible rows.
    rows: { selector: ".workboard-card", minimum: 1 },
  },
  plugin: {
    ready: ".workboard-card",
    search: `?${new URLSearchParams({
      plugin: "workboard",
      id: "workboard",
      "p.boardId": workboardResourceRoute.split("/").at(-1)!,
    })}`,
    rows: { selector: ".workboard-card", minimum: 1 },
  },
};

export const engineRouteTransitionCoverage = APP_ROUTE_IDS.map((id) => ({
  id,
  path: `${transitionDefinitions[id]?.pathname ?? pathForRoute(id)}${transitionDefinitions[id]?.search ?? ""}`,
  status: "measured" as const,
}));

/** One browser context per source preserves warm route and component identities. */
export function createEngineRouteTransitionScenarios(
  collect: EngineRouteTransitionCallback,
  targetPaths?: readonly string[],
): readonly EngineScenario[] {
  const routeIds = APP_ROUTE_IDS;
  const targets = routeIds.map((id) => {
    const definition = transitionDefinitions[id];
    assert(definition, `Missing transition definition for ${id}`);
    return { id, definition };
  });
  const aliases: Array<{ id: RouteId; pathname: string }> = [
    { id: "channels", pathname: "/channels" },
    { id: "config", pathname: "/config" },
    { id: "profile", pathname: "/profile" },
    { id: "communications", pathname: "/communications" },
    { id: "appearance", pathname: "/appearance" },
    { id: "lobsterdex", pathname: "/lobsterdex" },
    { id: "automation", pathname: "/automation" },
    { id: "mcp", pathname: "/mcp" },
    { id: "infrastructure", pathname: "/infrastructure" },
    { id: "ai-agents", pathname: "/ai-agents" },
    { id: "model-setup", pathname: "/model-setup" },
    { id: "model-providers", pathname: "/model-providers" },
    { id: "memory-import", pathname: "/settings/memory-import" },
    { id: "worktrees", pathname: "/settings/worktrees" },
    { id: "sessions", pathname: "/settings/sessions" },
    { id: "cron", pathname: "/cron" },
    { id: "devices", pathname: "/nodes" },
  ];
  targets.push(
    ...aliases.map(({ id, pathname }) => ({
      id,
      definition:
        id === "model-setup"
          ? {
              ...transitionDefinitions["model-providers"]!,
              pathname,
              search: "",
              landed: "model-providers" as const,
            }
          : { ...transitionDefinitions[id]!, pathname },
    })),
  );
  const redirects: Array<{
    id: RouteId;
    search: string;
    landed: RouteId;
    ready?: string;
  }> = [
    { id: "communications", search: "?section=__notifications__", landed: "notifications" },
    { id: "communications", search: "?section=channels", landed: "channels" },
    { id: "communications", search: "?section=broadcast", landed: "advanced" },
    { id: "communications", search: "?section=talk", landed: "talk" },
    { id: "appearance", search: "?section=wizard", landed: "advanced" },
    { id: "advanced", search: "?section=transcripts", landed: "communications" },
    { id: "automation", search: "?section=approvals", landed: "security" },
    {
      id: "automation",
      search: "?section=plugins",
      landed: "plugin-settings",
      ready: "#plugin-settings-advanced .settings-row",
    },
    {
      id: "ai-agents",
      search: "?section=memory",
      landed: "memory",
      ready: '#memory-settings-panel select[aria-label="Memory engine"]',
    },
    { id: "ai-agents", search: "?section=models", landed: "model-providers" },
    { id: "model-setup", search: "", landed: "model-providers" },
  ];
  targets.push(
    ...redirects.map(({ id, search, landed, ready: redirectedReady }) => ({
      id,
      // Inventory counts describe the whole default page, not a relocated section.
      definition: {
        ...transitionDefinitions[landed]!,
        completion: undefined,
        ...(redirectedReady ? { ready: redirectedReady, rows: undefined } : {}),
        pathname: pathForRoute(id),
        search,
        landed,
      },
    })),
  );
  const selectedTargets = targetPaths
    ? targets.filter(({ id, definition }) =>
        targetPaths.includes(
          `${definition.pathname ?? pathForRoute(id)}${definition.search ?? ""}`,
        ),
      )
    : targets;
  if (
    targetPaths?.some(
      (path) =>
        !selectedTargets.some(
          ({ id, definition }) =>
            `${definition.pathname ?? pathForRoute(id)}${definition.search ?? ""}` === path,
        ),
    )
  ) {
    throw new Error("Unknown transition target path");
  }
  const broadFixture = createPageFixture(definitions.systems!, "systems");
  const sources = [...new Set(Object.values(definitions).flatMap((entry) => entry.source ?? []))];
  const fixtureOverrides: NonNullable<EngineScenario["fixtureOverrides"]> = (sandbox, base) => {
    const broad = broadFixture(sandbox, base);
    const domains = sources.map((source) => source.fixtureOverrides?.(sandbox, base));
    return {
      ...broad,
      sessionKey: base.sessionKey,
      featureMethods: [
        ...new Set([
          ...(base.featureMethods ?? []),
          ...(broad.featureMethods ?? []),
          ...domains.flatMap((domain) => domain?.featureMethods ?? []),
        ]),
      ],
      methodResponses: Object.assign(
        {},
        ...domains.map((domain) => domain?.methodResponses),
        broad.methodResponses,
        {
          "cron.list": base.methodResponses?.["cron.list"],
          "cron.status": base.methodResponses?.["cron.status"],
        },
      ),
      sessionTranscripts: {
        ...broad.sessionTranscripts,
        ...Object.assign({}, ...domains.map((domain) => domain?.sessionTranscripts)),
        ...base.sessionTranscripts,
      },
    };
  };
  return routeIds.map((from): EngineScenario => {
    const source = transitionDefinitions[from]!;
    const enterSource = async (page: Page) => {
      if (source.pathname) {
        await measureVisit(page, from, source);
      } else {
        await navigate(page, from, source.search);
      }
      await ready(page, from, source);
    };
    return {
      id: `remount-from-${from}`,
      explicitOnly: true,
      route: "/new",
      expected: `Count retained and rebuilt subtrees from ${from} to every supported route, alias and retired URL.`,
      fixture:
        from === "plugin" ||
        from === "workboard" ||
        selectedTargets.some(({ id }) => id === "plugin" || id === "workboard")
          ? { workboardResources: true }
          : undefined,
      fixtureOverrides,
      initScript: createColdLoadProbeInitScript({
        ownerProbes: false,
        sidebarCounters: false,
        latencyMs: 0,
        frameGapMs: 0,
        events: [],
      }),
      prepare: async (page) => {
        await waitForControlUiRoute(page, { routeId: "new-session" });
        await enterSource(page);
      },
      run: async (page) => {
        let transitions = 0;
        for (const { id: to, definition } of selectedTargets) {
          const path = `${definition.pathname ?? pathForRoute(to)}${definition.search ?? ""}`;
          const sourcePath = `${source.pathname ?? pathForRoute(from)}${source.search ?? ""}`;
          if (path === sourcePath) {
            continue;
          }
          await enterSource(page);
          await collect(page, { from, to, path }, async () => {
            const timing = await measureVisit(page, to, definition, 10_000);
            await ready(page, to, definition);
            return timing.contentReadyMs;
          });
          transitions += 1;
        }
        return { transitions };
      },
    };
  });
}
