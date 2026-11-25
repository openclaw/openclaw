import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import {
  chooseSidebarMenuOption,
  closeSidebarMenu,
} from "../../ui/src/e2e/sidebar-session-menu.test-support.ts";
import type { ControlUiMockGatewayScenario } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../../ui/src/test-helpers/skill-library-fixtures.ts";
import { parityWorkboardScenario, sessionKey } from "../control-ui-parity/fixtures.ts";
import { baseScenario, type Scene } from "../control-ui-parity/scenarios.ts";

const chat = {
  route: "chat",
  path: `/chat?session=${sessionKey}`,
  ready: "openclaw-chat-pane",
} as const;
const secrets = {
  route: "secrets",
  path: "/settings/secrets",
  ready: "openclaw-secrets-page",
} as const;
const channels = {
  route: "channels",
  path: "/settings/channels",
  ready: "openclaw-channels-page",
} as const;
const skills = {
  route: "skill-settings",
  path: "/settings/skills?agent=main",
  ready: "openclaw-skills-page",
} as const;
const [ownSkill, sharedSkill, teamSkill] = buildSkillLibraryMock();
const banner = readFileSync(new URL("../../docs/assets/openclaw-banner-dark.png", import.meta.url));

// These fixtures and controls come from the corresponding production E2E suites.
// Keep drafts pristine: the enclosing census dismisses twice, then retires the route.
const groupScenario: ControlUiMockGatewayScenario = {
  sessionGroups: ["Client work"],
  sessions: baseScenario.sessions?.map((session) => ({ ...session, category: "Client work" })),
  sessionGroupDefaults: { "Client work": { cwd: "/synthetic/client-work", worktree: true } },
  workspace: "/synthetic/client-work",
  workspaceGit: true,
  methodResponses: {
    "worktrees.branches": {
      branches: [{ kind: "local", name: "main" }],
      defaultBranch: "main",
      repositoryStatus: "git",
    },
  },
};
const secretScenario: ControlUiMockGatewayScenario = {
  featureMethods: [...baseScenario.featureMethods!, "secrets.store.set", "secrets.store.delete"],
  methodResponses: {
    "secrets.store.list": {
      entries: [
        {
          name: "SERVICE_URL",
          kind: "env",
          value: "https://service.test",
          scopeKind: "team",
          scopeId: "",
          createdAtMs: 1,
          updatedAtMs: 2,
          updatedBy: "Proof operator",
        },
      ],
    },
  },
};
const skillScenario: ControlUiMockGatewayScenario = {
  operatorScopes: ["operator.read", "operator.write"],
  methodResponses: {
    "skills.library.list": {
      entries: [ownSkill.entry, sharedSkill.entry, teamSkill.entry],
      profileId: "profile-alice",
      multipleProfiles: true,
      defaultTarget: "personal",
      canManageWorkspace: false,
      defaultSelectionLimit: 64,
    },
    "skills.status": {
      workspaceDir: "/synthetic/workspace",
      managedSkillsDir: "/synthetic/skills",
      skills: [],
    },
    "skills.library.read": ownSkill,
  },
};
const channelScenario: ControlUiMockGatewayScenario = {
  featureMethods: [...baseScenario.featureMethods!, "wizard.start", "wizard.cancel"],
  methodResponses: {
    "channels.status": {
      ts: 1,
      channelOrder: ["imessage"],
      channelLabels: { imessage: "iMessage" },
      channelMeta: [{ id: "imessage", label: "iMessage" }],
      channels: { imessage: { configured: true, running: true } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    },
    "channels.pairing.list": {
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    },
    "wizard.start": {
      sessionId: "retention-channel-wizard",
      done: false,
      status: "running",
      step: {
        id: "account",
        type: "select",
        message: "Account",
        initialValue: "primary",
        options: [
          {
            value: "primary",
            label: "Primary iMessage connection",
            hint: "The main iMessage connection for this OpenClaw gateway",
          },
          { value: "another", label: "Add another iMessage account" },
        ],
      },
    },
  },
};

async function openGroupOptions(page: Page) {
  await chooseSidebarMenuOption(page, "Status", "All");
  await closeSidebarMenu(page);
  const group = page.locator('[data-session-section="category:Client work"]');
  await group.waitFor();
  await group.locator(".sidebar-recent-sessions__head").hover();
  await group.getByRole("button", { name: "Group options for Client work", exact: true }).click();
}

async function openChannelDetail(page: Page) {
  await page
    .locator("button.channels-item, button.channels-item__detail", { hasText: "iMessage" })
    .first()
    .click();
  await page.locator(".channels-detail").waitFor();
}

export const dialogScenes: Scene[] = [
  {
    ...chat,
    id: "dialog-command-palette",
    label: "Command palette",
    prepare: async (page) => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.locator("openclaw-command-palette .cmd-palette__input:not([disabled])").waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-keyboard-shortcuts",
    label: "Keyboard shortcuts",
    prepare: async (page) => {
      await page
        .locator("openclaw-app-sidebar")
        .getByRole("button", { name: "Sessions", exact: true })
        .click();
      await page.keyboard.press("ControlOrMeta+/");
      await page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }).waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-agent-create",
    label: "Agent creation",
    scenario: {
      methodResponses: { "config.get": { exists: true, valid: true, sourceConfig: {} } },
    },
    prepare: async (page) => {
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-agent-card__main").click();
      await sidebar.locator('[data-value="command:new-agent"]').click();
      await page.locator(".agent-create-dialog").waitFor();
      // The dismissed picker leaves the pointer over a sidebar hovercard target.
      await page.mouse.move(0, 0);
    },
  },
  {
    ...chat,
    id: "dialog-group-defaults",
    label: "Session group defaults",
    scenario: groupScenario,
    prepare: async (page) => {
      await openGroupOptions(page);
      await page.getByRole("menuitem", { name: "New session defaults", exact: true }).click();
      await page
        .getByRole("dialog", { name: 'New session defaults for "Client work"', exact: true })
        .waitFor();
      await page.locator("[data-session-group-environment]").waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-group-confirm",
    label: "Generic delete confirmation",
    scenario: groupScenario,
    prepare: async (page) => {
      await openGroupOptions(page);
      await page.getByRole("menuitem", { name: "Delete group", exact: true }).click();
      await page.getByRole("dialog", { name: 'Delete group "Client work"', exact: true }).waitFor();
    },
  },
  {
    route: "new-session",
    path: "/new",
    ready: "openclaw-new-session-page",
    id: "dialog-connect-machine",
    label: "Connect a machine",
    prepare: async (page, gateway) => {
      const joinUrl = "https://gateway.example.test/j/retention";
      const command = `npx -y openclaw connect ${joinUrl} --service`;
      await gateway.setMethodResponse("device.pair.setupCode", {
        setupCode: "SYNTHETIC",
        joinUrl,
        command: `${command} --session-host`,
        serviceCommand: command,
        installedCommand: `openclaw connect ${joinUrl} --service --session-host`,
        gatewayUrl: "wss://gateway.example.test",
        auth: "token",
        urlSource: "test",
        access: "node",
        expiresAtMs: Date.now() + 600_000,
      });
      await page.locator("#new-session-where-trigger").click();
      await page.getByRole("button", { name: "Connect a device", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Connect a machine", exact: true });
      await dialog.waitFor();
      await dialog.getByText(`${command} --session-host`, { exact: true }).waitFor();
    },
  },
  {
    route: "security",
    path: "/settings/security",
    ready: ".security-page",
    id: "dialog-device-pair",
    label: "Device pairing setup",
    scenario: {
      methodResponses: {
        "device.pair.list": { paired: [], pending: [] },
        "node.list": { nodes: [] },
      },
    },
    prepare: async (page) => {
      await page
        .locator(".security-page")
        .getByRole("button", { name: "Pair device", exact: true })
        .click();
      await page.getByRole("dialog", { name: "Pair a device", exact: true }).waitFor();
      await page.getByRole("button", { name: "Create setup code", exact: true }).waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-update-confirm",
    label: "Update confirmation",
    prepare: async (page, gateway) => {
      const updateAvailable = {
        channel: "stable",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
      };
      await gateway.setMethodResponse("update.status", { updateAvailable });
      await gateway.emitGatewayEvent("update.available", { updateAvailable });
      await page.locator(".sidebar-issues-button:visible").click();
      const issue = page.locator(
        'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
      );
      await issue.locator("summary").click();
      await issue.locator(".sidebar-update-card__action").click();
      await page.getByRole("dialog", { name: "Update Gateway", exact: true }).waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-inbox",
    label: "Inbox with pending approval",
    prepare: async (page, gateway) => {
      await gateway.emitGatewayEvent("exec.approval.requested", {
        id: "retention-approval",
        createdAtMs: 1_000,
        expiresAtMs: Date.now() + 600_000,
        request: { command: "echo synthetic", agentId: "main", sessionKey: "agent:main:other" },
      });
      await page.locator("openclaw-sidebar-attention .sidebar-issues-button").click();
      await page
        .locator(
          'openclaw-sidebar-attention #sidebar-issues-panel [data-approval-id="retention-approval"]',
        )
        .waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-image-lightbox",
    label: "Transcript image lightbox",
    scenario: {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: `data:image/png;base64,${banner.toString("base64")}`,
              alt: "OpenClaw banner",
            },
          ],
          timestamp: 1_800_000_000_000,
        },
      ],
    },
    prepare: async (page) => {
      await page.getByRole("button", { name: "Open image OpenClaw banner", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Image preview: OpenClaw banner", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Download image", exact: true }).waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-expanded-table",
    label: "Expanded Markdown table",
    scenario: {
      historyMessages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "| State | Result |\n| --- | --- |\n| Synthetic | Ready |" },
          ],
          timestamp: 1_800_000_000_000,
        },
      ],
    },
    prepare: async (page) => {
      await page.getByRole("button", { name: "Expand table", exact: true }).click();
      await page.getByRole("dialog", { name: "Expanded table", exact: true }).waitFor();
      await page
        .locator("openclaw-modal-dialog.markdown-table-modal")
        .getByRole("cell", { name: "Ready", exact: true })
        .waitFor();
    },
  },
  {
    ...chat,
    id: "dialog-continue-terminal",
    label: "Continue in terminal",
    prepare: async (page) => {
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Advanced", exact: true }).hover();
      await page.getByRole("menuitem", { name: "Open in", exact: true }).hover();
      await page.getByText("Continue in terminal…", { exact: true }).click();
      await page.locator("openclaw-modal-dialog.continue-in-terminal-dialog").waitFor();
    },
  },
  {
    ...channels,
    id: "dialog-channel-detail",
    label: "Channel detail",
    scenario: channelScenario,
    prepare: openChannelDetail,
  },
  {
    ...channels,
    id: "dialog-channel-wizard",
    label: "Channel setup wizard",
    scenario: channelScenario,
    prepare: async (page) => {
      await openChannelDetail(page);
      await page
        .locator(".channels-detail")
        .getByRole("button", { name: "Run setup", exact: true })
        .click();
      await page
        .locator(".channels-wizard openclaw-select-picker .picker-select__trigger")
        .waitFor();
    },
  },
  ...(["Add", "Bulk Add"] as const).map((label): Scene => ({
    route: secrets.route,
    path: secrets.path,
    ready: secrets.ready,
    id: `dialog-secret-${label === "Add" ? "add" : "bulk"}`,
    label: `Secret ${label}`,
    scenario: secretScenario,
    prepare: async (page) => {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByRole("dialog", { name: label, exact: true }).waitFor();
      await page.locator(".secrets-store-dialog__actions").waitFor();
    },
  })),
  {
    ...secrets,
    id: "dialog-secret-edit",
    label: "Secret edit",
    scenario: secretScenario,
    prepare: async (page) => {
      await page
        .getByRole("row", { name: "SERVICE_URL", exact: true })
        .getByRole("button", { name: "Actions: SERVICE_URL", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      await page.getByRole("dialog", { name: "Edit", exact: true }).waitFor();
      await page.locator(".secrets-store-dialog__actions").waitFor();
    },
  },
  ...(["Create skill", "Import skill"] as const).map((label): Scene => ({
    route: skills.route,
    path: skills.path,
    ready: skills.ready,
    id: `dialog-skill-${label === "Create skill" ? "create" : "import"}`,
    label,
    scenario: skillScenario,
    prepare: async (page) => {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page
        .locator("openclaw-modal-dialog")
        .getByLabel("Skill name", { exact: true })
        .waitFor();
    },
  })),
  {
    ...skills,
    id: "dialog-skill-detail",
    label: "Skill library detail",
    scenario: skillScenario,
    prepare: async (page) => {
      await page.getByRole("button", { name: /release-notes Draft concise/u }).click();
      await page.locator("openclaw-modal-dialog").getByLabel("SKILL.md", { exact: true }).waitFor();
    },
  },
  {
    route: "workboard",
    path: "/workboard",
    ready: ".workboard",
    id: "dialog-workboard-create",
    label: "Workboard new card",
    scenario: parityWorkboardScenario,
    prepare: async (page) => {
      await page
        .locator(".workboard-heading__actions")
        .getByRole("button", { name: /New card/u })
        .click();
      await page.getByRole("dialog", { name: "New card", exact: true }).waitFor();
    },
  },
];
