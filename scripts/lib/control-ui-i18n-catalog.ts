import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaseHints } from "../../src/config/schema.hints.js";
import { PUBLIC_SESSION_COPY } from "../../src/shared/public-session-copy.ts";
import { configHintTranslationKey } from "../../ui/src/i18n/lib/config-hint-translation.ts";
import { registerActivityEnglish } from "../../ui/src/i18n/locales/en-activity.ts";
import { registerAgentsHomeEnglish } from "../../ui/src/i18n/locales/en-agents-home.ts";
import { registerApprovalsEnglish } from "../../ui/src/i18n/locales/en-approvals.ts";
import { registerAppsEnglish } from "../../ui/src/i18n/locales/en-apps.ts";
import { registerBoardWebsiteEnglish } from "../../ui/src/i18n/locales/en-board-website.ts";
import { registerBrowserEnglish } from "../../ui/src/i18n/locales/en-browser.ts";
import { registerChatCameraEnglish } from "../../ui/src/i18n/locales/en-chat-camera.ts";
import { registerChatCiEnglish } from "../../ui/src/i18n/locales/en-chat-ci.ts";
import { registerChatCommandResultsEnglish } from "../../ui/src/i18n/locales/en-chat-command-results.ts";
import { registerChatGoalsEnglish } from "../../ui/src/i18n/locales/en-chat-goals.ts";
import { registerChatMessageMetadataEnglish } from "../../ui/src/i18n/locales/en-chat-message-metadata.ts";
import { registerChatProviderReviewEnglish } from "../../ui/src/i18n/locales/en-chat-provider-review.ts";
import { registerCodeBlocksEnglish } from "../../ui/src/i18n/locales/en-code-blocks.ts";
import { registerCommandPaletteEnglish } from "../../ui/src/i18n/locales/en-command-palette.ts";
import { registerCronEnglish } from "../../ui/src/i18n/locales/en-cron.ts";
import { registerDebugEnglish } from "../../ui/src/i18n/locales/en-debug.ts";
import { registerDesktopEnglish } from "../../ui/src/i18n/locales/en-desktop.ts";
import { registerDevicesEnglish } from "../../ui/src/i18n/locales/en-devices.ts";
import { registerDreamingEnglish } from "../../ui/src/i18n/locales/en-dreaming.ts";
import { registerFilePreviewEnglish } from "../../ui/src/i18n/locales/en-file-preview.ts";
import { registerGitHubConnectionsEnglish } from "../../ui/src/i18n/locales/en-github-connections.ts";
import { registerGitHubEnglish } from "../../ui/src/i18n/locales/en-github.ts";
import { registerLabsEnglish } from "../../ui/src/i18n/locales/en-labs.ts";
import { registerLinkReaderEnglish } from "../../ui/src/i18n/locales/en-link-reader.ts";
import { registerLogbookEnglish } from "../../ui/src/i18n/locales/en-logbook.ts";
import { registerLoginEnglish } from "../../ui/src/i18n/locales/en-login.ts";
import { registerLogsEnglish } from "../../ui/src/i18n/locales/en-logs.ts";
import { registerMcpAppEnglish } from "../../ui/src/i18n/locales/en-mcp-app.ts";
import { registerMcpEnglish } from "../../ui/src/i18n/locales/en-mcp.ts";
import { registerMeetingsEnglish } from "../../ui/src/i18n/locales/en-meetings.ts";
import { registerMemoryImportEnglish } from "../../ui/src/i18n/locales/en-memory-import.ts";
import { registerModelAccountsEnglish } from "../../ui/src/i18n/locales/en-model-accounts.ts";
import { registerModelControlsEnglish } from "../../ui/src/i18n/locales/en-model-controls.ts";
import { registerModelSetupEnglish } from "../../ui/src/i18n/locales/en-model-setup.ts";
import { registerNewSessionSetupEnglish } from "../../ui/src/i18n/locales/en-new-session-setup.ts";
import { registerPersonalInstructionsEnglish } from "../../ui/src/i18n/locales/en-personal-instructions.ts";
import { registerPluginConsentEnglish } from "../../ui/src/i18n/locales/en-plugin-consent.ts";
import { registerPluginManagementEnglish } from "../../ui/src/i18n/locales/en-plugin-management.ts";
import { registerPortalsEnglish } from "../../ui/src/i18n/locales/en-portals.ts";
import { registerProcessesEnglish } from "../../ui/src/i18n/locales/en-processes.ts";
import { registerProfileEnglish } from "../../ui/src/i18n/locales/en-profile.ts";
import { registerSecretsStoreEnglish } from "../../ui/src/i18n/locales/en-secrets-store.ts";
import { registerSessionOrganizationEnglish } from "../../ui/src/i18n/locales/en-session-organization.ts";
import { registerSessionPeopleEnglish } from "../../ui/src/i18n/locales/en-session-people.ts";
import { registerSessionPlacementEnglish } from "../../ui/src/i18n/locales/en-session-placement.ts";
import { registerSettingsEnglish } from "../../ui/src/i18n/locales/en-settings.ts";
import { registerSidebarAttentionEnglish } from "../../ui/src/i18n/locales/en-sidebar-attention.ts";
import { registerSkillLibraryEnglish } from "../../ui/src/i18n/locales/en-skill-library.ts";
import { registerSkillWorkshopEnglish } from "../../ui/src/i18n/locales/en-skill-workshop.ts";
import { registerSkillsBrowserEnglish } from "../../ui/src/i18n/locales/en-skills-browser.ts";
import { registerSystemsEnglish } from "../../ui/src/i18n/locales/en-systems.ts";
import { registerToolDiagnosticsEnglish } from "../../ui/src/i18n/locales/en-tool-diagnostics.ts";
import { registerTranscriptsEnglish } from "../../ui/src/i18n/locales/en-transcripts.ts";
import { registerUpdateActionsEnglish } from "../../ui/src/i18n/locales/en-update-actions.ts";
import { registerUsageEnglish } from "../../ui/src/i18n/locales/en-usage.ts";
import { en } from "../../ui/src/i18n/locales/en.ts";
import {
  mergeControlUiTranslationMaps,
  setControlUiCatalogValue,
} from "./control-ui-i18n-catalog-values.ts";
import type { TranslationMap } from "./control-ui-i18n-sync-plan.ts";

// Host-only source composition for generation, verification, and Vite. The locale
// loader tracks these imports and reloads them in an isolated namespace.
const localesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../ui/src/i18n/locales",
);
const sourceFiles = [
  "en.ts",
  "en-agents.ts",
  "en-activity.ts",
  "en-agents-home.ts",
  "en-apps.ts",
  "en-logbook.ts",
  "en-logs.ts",
  "en-approvals.ts",
  "en-secrets-store.ts",
  "en-board-website.ts",
  "en-browser.ts",
  "en-chat-camera.ts",
  "en-chat-ci.ts",
  "en-chat-command-results.ts",
  "en-chat-goals.ts",
  "en-chat-message-metadata.ts",
  "en-chat-provider-review.ts",
  "en-code-blocks.ts",
  "en-command-palette.ts",
  "en-cron.ts",
  "en-debug.ts",
  "en-desktop.ts",
  "en-devices.ts",
  "en-dreaming.ts",
  "en-file-preview.ts",
  "en-processes.ts",
  "en-labs.ts",
  "en-login.ts",
  "en-link-reader.ts",
  "en-github.ts",
  "en-github-connections.ts",
  "en-mcp.ts",
  "en-mcp-app.ts",
  "en-meetings.ts",
  "en-memory-import.ts",
  "en-model-accounts.ts",
  "en-model-controls.ts",
  "en-model-setup.ts",
  "en-personal-instructions.ts",
  "en-session-organization.ts",
  "en-session-people.ts",
  "en-session-placement.ts",
  "en-new-session-setup.ts",
  "en-plugin-consent.ts",
  "en-plugin-management.ts",
  "en-portals.ts",
  "en-profile.ts",
  "en-settings.ts",
  "en-sidebar-attention.ts",
  "en-skill-library.ts",
  "en-session-skill-library.ts",
  "en-skill-workshop.ts",
  "en-skills-browser.ts",
  "en-systems.ts",
  "en-update-actions.ts",
  "en-tool-diagnostics.ts",
  "en-transcripts.ts",
  "en-usage.ts",
];

export function loadControlUiStartupCatalog(): TranslationMap {
  return en;
}

export function loadControlUiSourceCatalog(): TranslationMap {
  const newSession: TranslationMap = {};
  for (const [key, value] of Object.entries(registerNewSessionSetupEnglish.catalog.newSession)) {
    newSession[key] = value;
    if (key === "worktree") {
      for (const workspaceKey of [
        "newWorkspace",
        "newWorkspaceDescription",
        "remoteSourceUnavailable",
      ] as const) {
        newSession[workspaceKey] = registerNewSessionSetupEnglish.catalog.newSession[workspaceKey];
      }
    }
  }
  const sessionsView: TranslationMap = {};
  for (const [key, value] of Object.entries(
    registerSessionOrganizationEnglish.catalog.sessionsView,
  )) {
    sessionsView[key] = value;
    if (key === "searchPlaceholder") {
      Object.assign(sessionsView, registerCommandPaletteEnglish.catalog.sessionsView);
    }
    if (key === "assignToMe") {
      Object.assign(sessionsView, registerSessionPeopleEnglish.catalog.sessionsView);
    }
  }
  const boardWidget: TranslationMap = {};
  for (const [key, value] of Object.entries(en.board.widget)) {
    boardWidget[key] = value;
    if (key === "kindWebsite") {
      Object.assign(boardWidget, registerBoardWebsiteEnglish.catalog.board.widget);
    }
  }
  // Read fragment data without registering it into the shared runtime catalog.
  // en.ts's empty anchors retain source order for extracted whole subtrees.
  return mergeControlUiTranslationMaps(
    registerSkillLibraryEnglish.catalog,
    // Preserve partial-fragment key order while keeping shared labels eager.
    {
      ...en,
      secretsStore: registerSecretsStoreEnglish.catalog.secretsStore,
      custodian: {
        ...registerPluginManagementEnglish.catalog.custodian,
        ...en.custodian,
        autoSetup: registerPluginManagementEnglish.catalog.custodian.autoSetup,
      },
      chat: {
        ...en.chat,
        commands: registerCommandPaletteEnglish.catalog.chat.commands,
        welcome: registerCommandPaletteEnglish.catalog.chat.welcome,
        messages: registerChatMessageMetadataEnglish.catalog.chat.messages,
        pullRequests: registerGitHubEnglish.catalog.chat.pullRequests,
      },
      sessionHovercard: registerGitHubEnglish.catalog.sessionHovercard,
      githubPublication: registerGitHubEnglish.catalog.githubPublication,
      githubConnections: registerGitHubConnectionsEnglish.catalog.githubConnections,
      agentTools: {
        ...registerGitHubConnectionsEnglish.catalog.agentTools,
        ...en.agentTools,
        ...registerToolDiagnosticsEnglish.catalog.agentTools,
      },
      board: { ...en.board, widget: boardWidget },
      newSession,
      sessionsView,
      shortcutsOverlay: registerCommandPaletteEnglish.catalog.shortcutsOverlay,
      commandPalette: registerCommandPaletteEnglish.catalog.commandPalette,
      palette: registerCommandPaletteEnglish.catalog.palette,
      debug: registerDebugEnglish.catalog.debug,
      desktop: registerDesktopEnglish.catalog.desktop,
      pluginsPage: registerPluginManagementEnglish.catalog.pluginsPage,
      attention: registerSidebarAttentionEnglish.catalog.attention,
      profilePage: {
        ...en.profilePage,
        identity: registerProfileEnglish.catalog.profilePage.identity,
      },
    },
    registerActivityEnglish.catalog,
    registerAgentsHomeEnglish.catalog,
    registerAppsEnglish.catalog,
    registerLogbookEnglish.catalog,
    registerLogsEnglish.catalog,
    registerApprovalsEnglish.catalog,
    registerSecretsStoreEnglish.catalog,
    registerBrowserEnglish.catalog,
    registerChatCameraEnglish.catalog,
    registerChatCiEnglish.catalog,
    registerChatCommandResultsEnglish.catalog,
    registerChatGoalsEnglish.catalog,
    registerChatProviderReviewEnglish.catalog,
    registerCodeBlocksEnglish.catalog,
    registerCronEnglish.catalog,
    registerDevicesEnglish.catalog,
    registerDreamingEnglish.catalog,
    registerFilePreviewEnglish.catalog,
    registerProcessesEnglish.catalog,
    registerLabsEnglish.catalog,
    registerLoginEnglish.catalog,
    registerLinkReaderEnglish.catalog,
    registerMcpEnglish.catalog,
    registerMcpAppEnglish.catalog,
    registerMeetingsEnglish.catalog,
    registerMemoryImportEnglish.catalog,
    registerModelAccountsEnglish.catalog,
    registerModelControlsEnglish.catalog,
    registerModelSetupEnglish.catalog,
    registerPersonalInstructionsEnglish.catalog,
    registerSessionPlacementEnglish.catalog,
    registerNewSessionSetupEnglish.catalog,
    registerPluginConsentEnglish.catalog,
    registerPluginManagementEnglish.catalog,
    registerPortalsEnglish.catalog,
    registerProfileEnglish.catalog,
    registerSettingsEnglish.catalog,
    registerSidebarAttentionEnglish.catalog,
    registerSkillWorkshopEnglish.catalog,
    registerSkillsBrowserEnglish.catalog,
    registerSystemsEnglish.catalog,
    registerUpdateActionsEnglish.catalog,
    registerTranscriptsEnglish.catalog,
    registerUsageEnglish.catalog,
    { publicReader: PUBLIC_SESSION_COPY },
    loadControlUiCoreHintCatalog(),
  );
}

export async function readControlUiSourceCatalog(): Promise<string> {
  const sources = await Promise.all(
    [
      ...sourceFiles.map((fileName) => path.join(localesDir, fileName)),
      path.resolve(localesDir, "../../../../src/shared/public-session-copy.ts"),
      path.resolve(localesDir, "../../../../extensions/active-memory/control-ui.presentation.json"),
      path.resolve(localesDir, "../../../../extensions/memory-wiki/control-ui.presentation.json"),
    ].map((filePath) => readFile(filePath, "utf8")),
  );
  return [...sources, JSON.stringify(loadControlUiCoreHintCatalog())].join("\n");
}

function loadControlUiCoreHintCatalog(): TranslationMap {
  const catalog: TranslationMap = {};
  for (const [hintPath, hint] of Object.entries(buildBaseHints()).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const field of ["label", "help"] as const) {
      const text = hint[field];
      if (text) {
        setControlUiCatalogValue(catalog, configHintTranslationKey(hintPath, field, text), text);
      }
    }
  }
  return catalog;
}
