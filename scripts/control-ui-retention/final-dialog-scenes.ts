import type { Page } from "playwright";
import { expect } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.ts";
import {
  pairingRequest,
  pairingSnapshot,
} from "../../ui/src/pages/channels/pairing.test-support.ts";
import {
  calendarInspection,
  calendarPlugin,
  inventory,
  pluginMethodResponses,
  pluginMethods,
} from "../../ui/src/pages/plugins/plugins.e2e.test-support.ts";
import { makeBoard, makeCard } from "../../ui/src/pages/workboard/workboard.e2e.test-support.ts";
import type { ControlUiMockGatewayScenario } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { parityWorkboardScenario, sessionKey } from "../control-ui-parity/fixtures.ts";
import { baseScenario, type Scene } from "../control-ui-parity/scenarios.ts";

const chat = {
  route: "chat",
  path: `/chat?session=${sessionKey}`,
  ready: "openclaw-chat-pane",
} as const;
const plugin = {
  route: "plugin-settings",
  path: "/settings/plugins/calendar-plus",
  ready: ".plugin-catalog-detail",
} as const;
const board = { route: "workboard", path: "/workboard", ready: ".workboard-card" } as const;
const agentMemory = {
  route: "agents",
  path: "/settings/agents/main/memory",
  ready: "openclaw-agent-memory-panel",
} as const;
const skill = {
  name: "Calendar guide",
  description: "Configure the calendar and review its supporting files.",
};
const calendarCatalog = {
  plugin: {
    id: "ch_Y2FsZW5kYXI",
    catalog: { name: calendarPlugin.name, official: false, latestVersion: "2.1.0", categories: [] },
    local: {
      present: true,
      installed: true,
      enabled: true,
      state: "enabled",
      pluginId: calendarPlugin.id,
      action: "manage",
    },
  },
  detail: {
    origin: "clawhub",
    packageName: "@acme/calendar",
    topics: [],
    configuration: [],
    mcpServers: [],
    skills: [skill],
    versions: [],
  },
};
const skillBundle = {
  name: skill.name,
  rootPath: "skills/calendar",
  entryPath: "SKILL.md",
  inventoryComplete: true,
  directories: ["references"],
  files: Object.entries({
    "SKILL.md": "# Calendar guide\n\nStart here. [Configuration](references/config.md)",
    "references/config.md": "# Configuration\n\nSynthetic calendar instructions.",
  }).map(([path, content]) => ({ path, content, sizeBytes: content.length, status: "ready" })),
};
const pluginScenario: ControlUiMockGatewayScenario = {
  featureMethods: [
    ...baseScenario.featureMethods!,
    ...pluginMethods,
    "plugins.skills.read",
    "tools.catalog",
  ],
  methodResponses: {
    ...pluginMethodResponses(),
    "plugins.list": inventory([calendarPlugin]),
    "plugins.catalog.get": calendarCatalog,
    "plugins.inspect": {
      ...calendarInspection,
      plugin: calendarPlugin,
      catalog: calendarCatalog,
      components: { ...calendarInspection.components, skills: [skill.name], skillDetails: [skill] },
    },
    "plugins.skills.read": skillBundle,
    "tools.catalog": {
      agentId: "main",
      profiles: [],
      groups: [
        {
          id: "plugin:calendar-plus",
          label: "Calendar",
          source: "plugin",
          pluginId: calendarPlugin.id,
          tools: [
            {
              id: "calendar_search",
              label: "Calendar search",
              description: "Search previous entries.",
              fullDescription: "Search previous calendar entries with a bounded result count.",
              parameters: [
                {
                  name: "query",
                  required: true,
                  type: "string",
                  description: "Calendar search text.",
                },
                {
                  name: "limit",
                  required: false,
                  type: "integer",
                  description: "Maximum number of results.",
                },
              ],
              source: "plugin",
              pluginId: calendarPlugin.id,
              defaultProfiles: [],
            },
          ],
        },
      ],
    },
  },
};
const card = makeCard(
  { id: "retention-card", title: "Synthetic retention card", labels: ["proof"] },
  1_800_000_000_000,
);
const boardScenario: ControlUiMockGatewayScenario = {
  ...parityWorkboardScenario,
  featureMethods: [
    ...parityWorkboardScenario.featureMethods!,
    "workboard.cards.update",
    "workboard.cards.delete",
  ],
  methodResponses: {
    ...parityWorkboardScenario.methodResponses,
    "workboard.cards.list": {
      cards: [card],
      statuses: ["todo", "done"],
      boards: [makeBoard("default", { total: 1, active: 1, byStatus: { todo: 1 } })],
    },
  },
};
const operatorScopes = [...baseScenario.operatorScopes!, "operator.pairing"];
const deviceId = "synthetic-retention-device";
const memoryConfig = {
  plugins: {
    slots: { memory: "memory-core" },
    entries: { "memory-core": { enabled: true }, "memory-wiki": { enabled: true } },
  },
};
const wikiPage = {
  title: "Synthetic retention notes",
  path: "syntheses/retention.md",
  content: "# Synthetic retention notes\n\nKeep the evidence reproducible.",
  totalLines: 3,
  truncated: false,
};
const memoryScenario: ControlUiMockGatewayScenario = {
  featureMethods: [
    ...baseScenario.featureMethods!,
    "config.patch",
    "doctor.memory.dreamDiary",
    "wiki.overview",
    "wiki.importInsights",
    "wiki.get",
  ],
  methodResponses: {
    "config.get": {
      config: memoryConfig,
      sourceConfig: memoryConfig,
      raw: JSON.stringify(memoryConfig),
      hash: "retention-memory",
      valid: true,
      issues: [],
    },
    "doctor.memory.status": {
      agentId: "main",
      provider: "local",
      embedding: { ok: true, checked: true },
      dreaming: {
        enabled: true,
        promotedToday: 0,
        shortTermCount: 0,
        phases: {},
        shortTermEntries: [],
        promotedEntries: [],
      },
    },
    "doctor.memory.dreamDiary": {
      found: true,
      path: "DREAMS.md",
      content: "# Dream Diary\n\nSynthetic retention entry.",
    },
    "wiki.importInsights": {
      sourceType: "chatgpt",
      totalItems: 0,
      totalClusters: 0,
      truncated: false,
      clusters: [],
    },
    "wiki.overview": {
      totalItems: 1,
      totalPages: 1,
      truncated: false,
      pageCounts: { synthesis: 1, entity: 0, concept: 0, source: 0, report: 0 },
      totalClaims: 1,
      totalQuestions: 0,
      totalContradictions: 0,
      clusters: [
        {
          key: "synthesis",
          label: "Syntheses",
          itemCount: 1,
          claimCount: 1,
          questionCount: 0,
          contradictionCount: 0,
          items: [
            {
              pagePath: wikiPage.path,
              title: wikiPage.title,
              kind: "synthesis",
              claimCount: 1,
              questionCount: 0,
              contradictionCount: 0,
              claims: ["Keep the evidence reproducible."],
              questions: [],
              contradictions: [],
              snippet: "Synthetic retention evidence.",
              updatedAt: "2026-10-22T00:00:00.000Z",
            },
          ],
        },
      ],
    },
    "wiki.get": wikiPage,
  },
};
const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
const clawScope = {
  input: "A public repository",
  job: "Summarize its releases",
  output: "A release brief",
  authority: "Read public sources only",
};
const clawReview = {
  revision: "a".repeat(64),
  reviewToken: "b".repeat(64),
  publisher: "maker",
  name: "@maker/release-brief",
  displayName: "Release Brief",
  version: "0.1.0",
  description: "Summarizes releases for a new user.",
  items: [
    {
      id: "file:workspace/checklist.md",
      kind: "file",
      label: "workspace/checklist.md",
      detail: "Check each date and citation.",
      included: true,
    },
  ],
  files: [
    { path: "CLAW.md", content: "Portable release instructions" },
    { path: "package.json", content: '{"name":"@maker/release-brief"}' },
    { path: "workspace/checklist.md", content: "Check each date and citation." },
  ],
  scope: clawScope,
};
const clawConfig = { gateway: { controlUi: { experimental: { templates: true } } } };

async function openCardDetails(page: Page) {
  const target = page.locator(".workboard-card").filter({ hasText: card.title });
  await target.press("Enter");
  await page.getByRole("dialog", { name: card.title, exact: true }).waitFor();
}

// Production recipes: pages/plugins/{plugin-skills,plugin-overview,plugins-runtime},
// pages/templates/creator-review, e2e/device-token-reconnect, pages/workboard/workboard.
// Pairing, Goal, and memory fixtures follow their scoped owner tests and real UI actions.
export const finalDialogScenes: Scene[] = [
  {
    ...plugin,
    id: "dialog-plugin-file-preview",
    label: "Plugin skill bundle file preview",
    scenario: pluginScenario,
    prepare: async (page) => {
      await page.getByRole("button", { name: /Calendar guide/u }).click();
      const modal = page.locator("openclaw-file-preview-modal");
      await modal.locator('[data-path="SKILL.md"][aria-current="true"]').waitFor();
      await modal.getByRole("link", { name: "Configuration", exact: true }).click();
      await modal.locator('[data-path="references/config.md"][aria-current="true"]').waitFor();
      await modal.getByText("Synthetic calendar instructions.", { exact: true }).waitFor();
      await modal.locator('.head button[aria-label="Close"]').click();
      await modal.waitFor({ state: "detached" });
    },
  },
  {
    ...plugin,
    id: "dialog-plugin-tool-preview",
    label: "Plugin tool preview",
    scenario: pluginScenario,
    prepare: async (page) => {
      await page.getByRole("button", { name: /calendar_search/u }).click();
      const dialog = page.getByRole("dialog", { name: "calendar_search", exact: true });
      await dialog.waitFor();
      await dialog
        .locator(".plugin-tool-preview__parameters")
        .getByText("Calendar search text.", { exact: true })
        .waitFor();
    },
  },
  {
    ...plugin,
    path: "/settings/plugins/calendar-plus#lifecycle",
    id: "dialog-plugin-consent",
    label: "Plugin capability consent",
    scenario: {
      ...pluginScenario,
      methodResponses: {
        ...pluginScenario.methodResponses,
        "plugins.list": inventory([{ ...calendarPlugin, enabled: false, state: "disabled" }]),
      },
    },
    prepare: async (page, gateway) => {
      const after = await gateway.deferNext("plugins.setEnabled");
      await page.getByRole("button", { name: "Enable Calendar Plus", exact: true }).click();
      await gateway.waitForRequest("plugins.setEnabled", { after });
      await gateway.rejectDeferred("plugins.setEnabled", {
        code: "INVALID_REQUEST",
        message: "Changed capabilities need review",
        details: buildCapabilityConsentErrorDetails({
          pluginId: "calendar-plus",
          reviewToken: calendarInspection.reviewToken,
        }),
      });
      await page
        .locator('[data-plugin-consent="enable"]')
        .getByRole("button", { name: "Enable Calendar Plus", exact: true })
        .waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-claw-review",
    label: "Template creator package review",
    scenario: {
      featureMethods: [
        ...baseScenario.featureMethods!,
        "templates.drafts.create",
        "templates.drafts.read",
        "templates.drafts.review",
        "templates.drafts.publish",
      ],
      methodResponses: {
        "config.get": {
          config: clawConfig,
          sourceConfig: clawConfig,
          raw: JSON.stringify(clawConfig),
          hash: "templates-review-config",
          valid: true,
          issues: [],
        },
        "templates.drafts.read": {
          content: JSON.stringify({ name: "release-brief", scope: clawScope }),
          revision: clawReview.revision,
        },
        "templates.drafts.review": clawReview,
      },
    },
    prepare: async (page) => {
      // The creator route hands off to chat. Use the public SPA navigation entry,
      // so the outer census does not wait for a route that intentionally redirects.
      await page.evaluate(
        (id) =>
          window.openclawControlUi!.navigate("templates", {
            pathname: "/templates",
            search: `?draft=${id}&agent=main`,
            hash: "",
          }),
        draftId,
      );
      const dialog = page.getByRole("dialog", { name: "Review your Template", exact: true });
      await dialog.waitFor();
      await expect
        .poll(() => dialog.getByLabel("Name", { exact: true }).inputValue())
        .toBe("Release Brief");
      await dialog.getByRole("button", { name: "Ask for changes", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    },
  },
  {
    route: "devices",
    path: "/settings/devices",
    ready: ".device-entry",
    id: "dialog-secret-reveal",
    label: "Rotated synthetic device token acknowledgement",
    scenario: {
      operatorScopes,
      featureMethods: [...baseScenario.featureMethods!, "device.token.rotate"],
      methodResponses: {
        "device.pair.list": {
          paired: [
            {
              deviceId,
              displayName: "Synthetic retention device",
              roles: ["operator"],
              scopes: operatorScopes,
              tokens: [{ createdAtMs: 1, role: "operator", scopes: operatorScopes }],
            },
          ],
          pending: [],
        },
        "device.token.rotate": {
          deviceId,
          role: "operator",
          scopes: operatorScopes,
          token: "SYNTHETIC_RETENTION_TOKEN",
          rotatedAtMs: 2,
          tokenDelivery: "in-band",
        },
        "node.list": { nodes: [] },
      },
    },
    prepare: async (page) => {
      const entry = page.locator(".device-entry").filter({ hasText: "Synthetic retention device" });
      const details = entry.locator("details.device-entry__details");
      if ((await details.getAttribute("open")) === null) {
        await details.locator("summary").click();
      }
      await entry.getByRole("button", { name: "Rotate", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "New operator token", exact: true });
      await dialog.getByText("SYNTHETIC_RETENTION_TOKEN", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "I saved this token", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
    },
  },
  {
    ...board,
    id: "dialog-workboard-filter",
    label: "Workboard filter popover",
    scenario: boardScenario,
    prepare: async (page) => {
      await page.locator(".workboard-filter-trigger").click();
      await page.locator(".workboard-filter-popover__panel").waitFor();
    },
  },
  ...(["edit", "delete"] as const).map((kind): Scene => ({
    route: board.route,
    path: board.path,
    ready: board.ready,
    id: `dialog-workboard-bulk-${kind}`,
    label: `Workboard bulk ${kind}`,
    scenario: boardScenario,
    prepare: async (page) => {
      const target = page.locator(".workboard-card").filter({ hasText: card.title });
      await target.press("Shift+Enter");
      const selection = page.locator(".workboard-selection");
      await selection
        .getByRole("button", { name: kind === "edit" ? "Edit properties" : "Delete", exact: true })
        .click();
      const dialog = page.locator(".workboard-bulk-dialog");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await selection.getByRole("button", { name: "Clear selection", exact: true }).click();
      await selection.waitFor({ state: "detached" });
    },
  })),
  {
    ...board,
    id: "dialog-workboard-labels",
    label: "Workboard inline labels popover",
    scenario: boardScenario,
    prepare: async (page) => {
      await openCardDetails(page);
      await page.locator(".workboard-detail__text-trigger--labels").click();
      const labels = page.locator(".workboard-detail__labels-popover");
      await labels.getByRole("textbox", { name: "Labels", exact: true }).waitFor();
      await labels.getByRole("button", { name: "Cancel", exact: true }).click();
      await labels.waitFor({ state: "hidden" });
      await page.locator(".workboard-detail__close").click();
      await page.locator(".workboard-detail-drawer").waitFor({ state: "detached" });
    },
  },
  {
    ...board,
    id: "dialog-workboard-property",
    label: "Workboard priority choice popover",
    scenario: boardScenario,
    prepare: async (page) => {
      await openCardDetails(page);
      await page.getByRole("button", { name: "Priority: Normal", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Priority", exact: true })
        .getByRole("radiogroup")
        .waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".workboard-detail__close").click();
      await page.locator(".workboard-detail-drawer").waitFor({ state: "detached" });
    },
  },
  {
    route: "channels",
    path: "/settings/channels",
    ready: ".channels-pairing-request",
    id: "dialog-channel-pairing",
    label: "Channel sender pairing decision",
    scenario: {
      operatorScopes,
      featureMethods: [
        ...baseScenario.featureMethods!,
        "channels.pairing.approve",
        "channels.pairing.dismiss",
      ],
      methodResponses: {
        "channels.pairing.list": pairingSnapshot({
          requests: [{ ...pairingRequest, expiresAt: "2099-01-01T00:00:00.000Z" }],
        }),
      },
    },
    prepare: async (page) => {
      await page
        .getByRole("button", {
          name: "Approve +15551234567 for WhatsApp, account Personal",
          exact: true,
        })
        .click();
      await page.locator(".channels-pairing-dialog").waitFor();
      await page
        .locator(".channels-pairing-dialog__actions")
        .getByRole("button", { name: "Cancel", exact: true })
        .waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-details-goal",
    label: "Mobile Details goal edit modal",
    scenario: {
      sessions: [
        {
          ...baseScenario.sessions![0],
          key: sessionKey,
          goal: {
            schemaVersion: 1,
            id: "goal-details",
            objective: "Review the release\nPreserve the checklist",
            status: "paused",
            createdAt: 1000,
            updatedAt: 2000,
            tokenStart: 0,
            tokensUsed: 120,
            continuationTurns: 0,
          },
        },
      ],
    },
    prepare: async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.activity-pill[data-family="goal"]:visible').click();
      await page
        .locator(".chat-details-goal")
        .getByRole("button", { name: "Edit goal", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Edit goal", exact: true });
      await expect
        .poll(() => dialog.locator('textarea[name="objective"]').inputValue())
        .toBe("Review the release\nPreserve the checklist");
    },
  },
  {
    route: "memory-import",
    path: "/memory-import",
    ready: '[data-test-id="memory-import-page"]',
    id: "dialog-memory-import",
    label: "Memory import confirmation",
    scenario: {
      featureMethods: [
        ...baseScenario.featureMethods!,
        "migrations.memory.plan",
        "migrations.memory.apply",
      ],
      methodResponses: {
        "migrations.memory.plan": {
          agentId: "main",
          workspace: "/synthetic/workspace",
          providers: [
            {
              providerId: "codex",
              label: "Codex",
              description: "Import Codex memory.",
              planFingerprint: "a".repeat(64),
              found: true,
              source: "/synthetic/codex",
              target: "/synthetic/workspace",
              summary: {
                total: 1,
                planned: 1,
                migrated: 0,
                skipped: 0,
                conflicts: 0,
                errors: 0,
                sensitive: 0,
              },
              items: [
                {
                  id: "memory:codex:MEMORY.md",
                  status: "planned",
                  source: "/synthetic/codex/MEMORY.md",
                  target: "/synthetic/workspace/memory/imports/codex/MEMORY.md",
                  details: {
                    collectionId: "codex",
                    collectionLabel: "Codex",
                    relativePath: "MEMORY.md",
                  },
                },
              ],
            },
          ],
        },
      },
    },
    prepare: async (page) => {
      await page.locator('[data-test-id="memory-import-provider-button"]').click();
      await page
        .locator('.memory-import__confirm [data-test-id="memory-import-confirm"]')
        .waitFor();
    },
  },
  {
    ...agentMemory,
    id: "dialog-memory-toggle",
    label: "Dreaming toggle confirmation",
    scenario: memoryScenario,
    prepare: async (page) => {
      await page.getByRole("switch", { name: "Dreaming", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Turn Off Dreaming for All Agents", exact: true })
        .waitFor();
    },
  },
  {
    ...agentMemory,
    id: "dialog-memory-wiki",
    label: "Agent wiki document preview",
    scenario: memoryScenario,
    prepare: async (page) => {
      await page.locator("#dreams-tab-diary").click();
      await page.locator("#dream-diary-tab-wiki").click();
      await page.getByRole("button", { name: "Open wiki page", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: wikiPage.title, exact: true });
      await expect
        .poll(() => dialog.locator(".dreams-diary__preview-pre").textContent())
        .toContain("Keep the evidence reproducible.");
    },
  },
  {
    ...chat,
    id: "dialog-full-exec-approval",
    label: "Full exec approval: shell event contract; no browser UI dispatcher",
    prepare: async (page, gateway) => {
      await gateway.emitGatewayEvent("exec.approval.requested", {
        id: "retention-full-approval",
        createdAtMs: 1_000,
        expiresAtMs: Date.now() + 600_000,
        request: { command: "echo synthetic full approval", agentId: "main", sessionKey },
      });
      await page
        .locator('.chat-inline-approval [data-approval-id="retention-full-approval"]')
        .waitFor();
      // app-shell-chrome listens on window; this documented event also exercises
      // its lazy registration/replay path rather than mounting the renderer here.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("openclaw:approvals-open")));
      const modal = page.locator("openclaw-exec-approval openclaw-modal-dialog");
      await modal.locator(".exec-approval-modal-stack").waitFor();
      await modal.getByText("echo synthetic full approval", { exact: true }).waitFor();
    },
  },
];

export const finalDialogCoverageLimits = [
  "Full exec-approval overlay is exercised through its documented window shell-event contract; no production browser UI dispatcher was found. Inline approvals and Inbox are separate measured lifetimes.",
  "Native Gateway management belongs to the Linux companion renderer, not this production bundle.",
  "Native OS pickers and arbitrary third-party plugin dialogs are outside the core renderer census; native-rendered core overlays are not excluded by that limitation.",
];
