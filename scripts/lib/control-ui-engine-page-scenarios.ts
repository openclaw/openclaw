import assert from "node:assert/strict";
import type { Page } from "playwright";
import type {
  EnvironmentSummary,
  PortalSummary,
  SkillWorkshopChange,
  SystemChangeEntry,
  SystemChangesListResult,
} from "../../packages/gateway-protocol/src/index.ts";
import type { UserProfile } from "../../packages/gateway-protocol/src/schema/users.ts";
import type { loadVoiceWakeConfig } from "../../src/infra/voicewake.ts";
import type { ModelAuthStatusResult } from "../../ui/src/api/types.ts";
import { APP_ROUTE_IDS, pathForRoute, type RouteId } from "../../ui/src/app-route-paths.ts";
import type { ColdLoadRpcRecord } from "../../ui/src/test-helpers/control-ui-cold-load-probe-init.ts";
import { createColdLoadProbeInitScript } from "../../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import { waitForControlUiRoute } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  meetingEntry,
  meetingPage,
  meetingStatus,
} from "../../ui/src/test-helpers/transcripts.test-support.ts";
import { parityBaseScenario, parityWorkboardScenario } from "../control-ui-parity/fixtures.ts";
import { dataActivityScenarios } from "./control-ui-data-activity-scenarios.ts";
import { dataCatalogScenarios } from "./control-ui-data-catalog-scenarios.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { interactionScenarios } from "./control-ui-interaction-scenarios.ts";
import type {
  InteractionEvidence,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

type PageAction = {
  label: string;
  run: InteractionScenario["run"];
};
type PageDefinition = {
  ready: string;
  rows?: { selector: string; minimum: number; totalSelector?: string };
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
};
const quantity = enginePageFixtureCounts;
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
function refresh(selector: string, method: string): PageAction {
  return {
    label: `Refresh ${method}`,
    run: async (page, gateway) => {
      const before = (await gateway.getRequests(method)).length;
      await page.locator(selector).first().click();
      await gateway.waitForRequest(method, { after: before });
      await frames(page);
      await page.locator(`${selector}:enabled`).first().waitFor({ state: "visible" });
      assert.equal(await page.locator('.agents-toolbar [role="alert"]').count(), 0);
      return { refreshRequests: (await gateway.getRequests(method)).length - before };
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
    ready: "openclaw-agents-page .agents-refresh-btn:enabled",
    action: refresh(".agents-refresh-btn", "agents.list"),
  },
  approvals: {
    ready: ".approval-history-table tbody tr",
    rows: { selector: ".approval-history-table tbody tr", minimum: 100 },
    action: {
      label: "Load the next 100 approval-history records",
      run: async (page) => {
        await page.locator('openclaw-approvals-page button:text-is("Load more")').click();
        await page.waitForFunction(
          () => document.querySelectorAll(".approval-history-table tbody tr").length === 200,
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
        await page.locator(".cloud-environments__advanced > summary").click();
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
    action: disclosure("openclaw-connection-page details"),
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
      label: "Filter 200 dashboards to one match",
      run: async (page) => {
        await page.locator("openclaw-dashboards-page input[type=search]").fill("Interaction 0995");
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
      label: "Open the first device action menu and focus its enabled Copy item",
      run: async (page) => {
        const trigger = page.locator("openclaw-devices-page .device-entry__menu-trigger").first();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        const menuId = await trigger.getAttribute("aria-controls");
        assert(menuId, "The device action trigger must identify its own menu");
        const menu = page.locator(`[role="menu"][id=${JSON.stringify(menuId)}]`);
        await trigger.click();
        await menu.waitFor({ state: "visible" });
        await page.waitForFunction((id) => {
          const surface = document.getElementById(id);
          return (
            surface?.matches(":popover-open") &&
            surface.querySelector('[role="menuitem"][data-value="copy"]') === document.activeElement
          );
        }, menuId);
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        assert.equal(await menu.locator('[role="menuitem"][data-value="copy"]').isEnabled(), true);
        assert.equal(
          await menu.locator('[role="menuitem"][data-value="remove"]').isEnabled(),
          true,
        );
        const menuItems = await menu.locator('[role="menuitem"]').count();
        assert.equal(menuItems, 2);
        await frames(page);
        return { firstMenuOpened: true, copyFocused: true, menuItems };
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
        await page
          .locator(".portals-preview__notice")
          .getByText("This portal requires an operator with write access.", { exact: true })
          .waitFor();
        assert.equal(await page.locator("openclaw-portals-page iframe").count(), 0);
        await frames(page);
        return {
          selectedPortal: 1,
          portalCount: await page.locator(".portals-rail__item").count(),
        };
      },
    },
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
      label: "Run a mock search and present its result",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("webSearch.test")).length;
        const input = page.locator('openclaw-search-page input[aria-label="Search query"]');
        await input.fill("Synthetic search census");
        await input.press("Enter");
        await gateway.waitForRequest("webSearch.test", { after: before });
        await page
          .locator("openclaw-search-page .settings-row__title")
          .getByText("Synthetic census search result", { exact: true })
          .waitFor();
        await frames(page);
        return { searchResults: 1 };
      },
    },
  },
  secrets: {
    ready: "openclaw-secrets-page .secrets-store__table tbody tr",
    rows: { selector: "openclaw-secrets-page .secrets-store__table tbody tr", minimum: 200 },
    action: {
      label: "Open the first secret's row menu and edit its metadata",
      run: async (page) => {
        const row = page.locator(".secrets-store__table tbody tr").first();
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
      label: "Filter 1,000 installed skills to one match",
      run: async (page) => {
        await page.locator(".skills-toolbar__search input").fill("Data skill 0999");
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
    ready: '.systems-workspace button[aria-label="Machine details"]:enabled',
    rows: { selector: ".systems-mobile-picker option:not(:disabled)", minimum: 61 },
    action: click('.systems-workspace button[aria-label="Machine details"]', ".systems-details"),
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
        const form = card.locator(".mcp-server-form");
        await form.locator('input[name="mcp-name"]:enabled').waitFor({ state: "visible" });
        await form.locator('input[name="mcp-target"]:enabled').waitFor({ state: "visible" });
        assert.equal(
          await form.locator('select[name="mcp-transport"]').inputValue(),
          "streamable-http",
        );
        await frames(page);
        return { addServerForm: true };
      },
    },
  },
  memory: {
    ready: ".memory-overview__hero-copy h2",
    action: {
      label: "Refresh the memory engine status",
      run: async (page, gateway) => {
        const before = (await gateway.getRequests("doctor.memory.status")).length;
        await page.locator(".memory-overview__hero-actions button").click();
        await gateway.waitForRequest("doctor.memory.status", {
          after: before,
          match: { agentId: "main" },
        });
        await page
          .locator(".memory-overview__hero-copy h2")
          .getByText("Memory is awake", { exact: true })
          .waitFor();
        assert.equal(await page.locator(".memory-overview__hero-error").count(), 0);
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
  "ai-agents": configPage(),
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
      label: "Filter 500 automations to one match",
      run: requiredScenario(interactionScenarios, "cron-search").run,
    },
  },
};

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
): EngineScenario["fixtureOverrides"] {
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
      gateway: { controlUi: { experimental: { templates: true } } },
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
        "config.get": {
          config,
          sourceConfig: config,
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

async function measureVisit(page: Page, id: RouteId, definition: PageDefinition) {
  return page.evaluate(
    ({ id: routeId, pathname, search: routeSearch, landed, selector, rows }) =>
      new Promise<number>((resolve, reject) => {
        const started = performance.now();
        let readyFrames = 0;
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
            resolve(performance.now() - started);
          } else if (performance.now() - started > 60_000) {
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
      pathname: pathForRoute(id),
      search: definition.search ?? "",
      landed: definition.landed ?? id,
      selector: definition.ready,
      rows: definition.rows,
    },
  );
}

/** One fresh context per phase preserves first-visit lazy imports and isolates local drafts. */
export function createEnginePageScenarios(): readonly EngineScenario[] {
  const boot = (page: Page) => waitForControlUiRoute(page, { routeId: "new-session" });
  return enginePageCoverage.flatMap((coverage) => {
    if (coverage.status === "excluded" || coverage.status === "unavailable") {
      return [];
    }
    const definition = definitions[coverage.id];
    assert(definition, `Missing census definition for ${coverage.id}`);
    const id = coverage.id;
    const common = {
      explicitOnly: true,
      route: "/new",
      fixtureOverrides: createPageFixture(definition, id),
      ...(id === "cloud-workers"
        ? {
            initScript: createColdLoadProbeInitScript({
              ownerProbes: false,
              sidebarCounters: false,
              latencyMs: 0,
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
    const visit: EngineScenario = {
      ...common,
      id: `page-${id}-visit`,
      expected: `First visit after boot to ${coverage.path}; ${definition.ready} is visible and the route is settled.`,
      prepare: boot,
      run: async (page) => {
        const visitReadyMs = await measureVisit(page, id, definition);
        await ready(page, id, definition);
        return { visitReadyMs };
      },
    };
    const leave: EngineScenario = {
      ...common,
      id: `page-${id}-leave`,
      expected: `Leaving ${coverage.path} retires its presentation and settles the static About page (Connection when leaving About).`,
      prepare: enter,
      run: async (page) => {
        const destination = id === "about" ? "connection" : "about";
        const leaveReadyMs = await measureVisit(page, destination, definitions[destination]!);
        await frames(page);
        assert.equal(await page.locator(definition.ready).filter({ visible: true }).count(), 0);
        return { retired: true, leaveReadyMs };
      },
    };
    if (!definition.action) {
      return [visit, leave];
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
    if (id === "search") {
      const firstAdvancedOpen: EngineScenario = {
        ...common,
        id: "page-search-advanced-open",
        expected: "First opening of Search Advanced settings presents the config fields.",
        prepare: enter,
        run: async (page) => {
          const advanced = page.locator(".config-advanced-disclosure");
          const fields = advanced.locator(":scope > .settings-group > .settings-row");
          const inputs = advanced.locator("input, select, textarea, button");
          assert.equal(await advanced.getAttribute("open"), null);
          const mountedFieldsBefore = await fields.count();
          await advanced.locator(":scope > summary").click();
          // The base schema has three numeric fields and the native-search object (ten controls).
          await page.waitForFunction(() => {
            const details = document.querySelector<HTMLDetailsElement>(
              ".config-advanced-disclosure",
            );
            return (
              details?.open &&
              details.querySelectorAll(":scope > .settings-group > .settings-row").length === 4 &&
              details.querySelectorAll("input, select, textarea, button").length === 10
            );
          });
          await frames(page);
          return {
            opened: true,
            mountedFieldsBefore,
            mountedFields: await fields.count(),
            mountedInputs: await inputs.count(),
          };
        },
      };
      return [visit, action, leave, firstAdvancedOpen];
    }
    if (id === "terminal") {
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
      return [visit, action, leave, composerInput];
    }
    return [visit, action, leave];
  });
}
