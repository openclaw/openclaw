import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaseHints } from "../../src/config/schema.hints.js";
import { PUBLIC_SESSION_COPY } from "../../src/shared/public-session-copy.ts";
import { configHintTranslationKey } from "../../ui/src/i18n/lib/config-hint-translation.ts";
import { registerAboutEnglish } from "../../ui/src/i18n/locales/en-about.ts";
import { registerActivityEnglish } from "../../ui/src/i18n/locales/en-activity.ts";
import { registerAgentCreationEnglish } from "../../ui/src/i18n/locales/en-agent-creation.ts";
import { registerAgentsHomeEnglish } from "../../ui/src/i18n/locales/en-agents-home.ts";
import { registerApprovalsEnglish } from "../../ui/src/i18n/locales/en-approvals.ts";
import { registerAppsEnglish } from "../../ui/src/i18n/locales/en-apps.ts";
import { registerAssistantContextEnglish } from "../../ui/src/i18n/locales/en-assistant-context.ts";
import { registerBoardDocumentEnglish } from "../../ui/src/i18n/locales/en-board-document.ts";
import { registerBoardWebsiteEnglish } from "../../ui/src/i18n/locales/en-board-website.ts";
import { registerBoardEnglish } from "../../ui/src/i18n/locales/en-board.ts";
import { registerBrowserEnglish } from "../../ui/src/i18n/locales/en-browser.ts";
import { registerChatCameraEnglish } from "../../ui/src/i18n/locales/en-chat-camera.ts";
import { registerChatCiEnglish } from "../../ui/src/i18n/locales/en-chat-ci.ts";
import { registerChatCommandResultsEnglish } from "../../ui/src/i18n/locales/en-chat-command-results.ts";
import { registerChatComposerEnglish } from "../../ui/src/i18n/locales/en-chat-composer.ts";
import { registerChatDetailsEnglish } from "../../ui/src/i18n/locales/en-chat-details.ts";
import { registerChatGoalsEnglish } from "../../ui/src/i18n/locales/en-chat-goals.ts";
import { registerChatMediaEnglish } from "../../ui/src/i18n/locales/en-chat-media.ts";
import { registerChatMessageMetadataEnglish } from "../../ui/src/i18n/locales/en-chat-message-metadata.ts";
import { registerChatOutputsEnglish } from "../../ui/src/i18n/locales/en-chat-outputs.ts";
import { registerChatProviderReviewEnglish } from "../../ui/src/i18n/locales/en-chat-provider-review.ts";
import { registerChatQuestionsEnglish } from "../../ui/src/i18n/locales/en-chat-questions.ts";
import { registerChatSessionEnglish } from "../../ui/src/i18n/locales/en-chat-session.ts";
import { registerChatToolContentEnglish } from "../../ui/src/i18n/locales/en-chat-tool-content.ts";
import { registerChatToolLabelsEnglish } from "../../ui/src/i18n/locales/en-chat-tool-labels.ts";
import { registerClawsEnglish } from "../../ui/src/i18n/locales/en-claws.ts";
import { registerCodeBlocksEnglish } from "../../ui/src/i18n/locales/en-code-blocks.ts";
import { registerCommandPaletteEnglish } from "../../ui/src/i18n/locales/en-command-palette.ts";
import { registerConnectionRecoveryEnglish } from "../../ui/src/i18n/locales/en-connection-recovery.ts";
import { registerCronEnglish } from "../../ui/src/i18n/locales/en-cron.ts";
import { registerDashboardsEnglish } from "../../ui/src/i18n/locales/en-dashboards.ts";
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
import { registerNativeLinkMenuEnglish } from "../../ui/src/i18n/locales/en-native-link-menu.ts";
import { registerNewSessionSetupEnglish } from "../../ui/src/i18n/locales/en-new-session-setup.ts";
import { registerPersonalInstructionsEnglish } from "../../ui/src/i18n/locales/en-personal-instructions.ts";
import { registerPluginConsentEnglish } from "../../ui/src/i18n/locales/en-plugin-consent.ts";
import { registerPluginManagementEnglish } from "../../ui/src/i18n/locales/en-plugin-management.ts";
import { registerPortalsEnglish } from "../../ui/src/i18n/locales/en-portals.ts";
import { registerPreferencesEnglish } from "../../ui/src/i18n/locales/en-preferences.ts";
import { registerProcessesEnglish } from "../../ui/src/i18n/locales/en-processes.ts";
import { registerProfileEnglish } from "../../ui/src/i18n/locales/en-profile.ts";
import { registerRouteSubtitlesEnglish } from "../../ui/src/i18n/locales/en-route-subtitles.ts";
import { registerSecretsStoreEnglish } from "../../ui/src/i18n/locales/en-secrets-store.ts";
import { registerSessionMachineEnglish } from "../../ui/src/i18n/locales/en-session-machine.ts";
import { registerSessionNavigationEnglish } from "../../ui/src/i18n/locales/en-session-navigation.ts";
import { registerSessionOrganizationEnglish } from "../../ui/src/i18n/locales/en-session-organization.ts";
import { registerSessionPeopleEnglish } from "../../ui/src/i18n/locales/en-session-people.ts";
import { registerSessionPlacementEnglish } from "../../ui/src/i18n/locales/en-session-placement.ts";
import { registerSessionProgressEnglish } from "../../ui/src/i18n/locales/en-session-progress.ts";
import { registerSettingsEnglish } from "../../ui/src/i18n/locales/en-settings.ts";
import { registerSidebarAttentionEnglish } from "../../ui/src/i18n/locales/en-sidebar-attention.ts";
import { registerSkillLibraryEnglish } from "../../ui/src/i18n/locales/en-skill-library.ts";
import { registerSkillWorkshopEnglish } from "../../ui/src/i18n/locales/en-skill-workshop.ts";
import { registerSkillsBrowserEnglish } from "../../ui/src/i18n/locales/en-skills-browser.ts";
import { registerSystemsEnglish } from "../../ui/src/i18n/locales/en-systems.ts";
import { registerTerminalEnglish } from "../../ui/src/i18n/locales/en-terminal.ts";
import { registerToolDiagnosticsEnglish } from "../../ui/src/i18n/locales/en-tool-diagnostics.ts";
import { registerTranscriptsEnglish } from "../../ui/src/i18n/locales/en-transcripts.ts";
import { registerUpdateActionsEnglish } from "../../ui/src/i18n/locales/en-update-actions.ts";
import { registerUsageEnglish } from "../../ui/src/i18n/locales/en-usage.ts";
import { registerWorkerCapacityEnglish } from "../../ui/src/i18n/locales/en-worker-capacity.ts";
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
  "en-session-progress.ts",
  "en-board-document.ts",
  "en-assistant-context.ts",
  "en-chat-outputs.ts",
  "en-native-link-menu.ts",
  "en-worker-capacity.ts",
  "en.ts",
  "en-route-subtitles.ts",
  "en-agents.ts",
  "en-about.ts",
  "en-dashboards.ts",
  "en-terminal.ts",
  "en-preferences.ts",
  "en-agent-creation.ts",
  "en-activity.ts",
  "en-agents-home.ts",
  "en-apps.ts",
  "en-logbook.ts",
  "en-logs.ts",
  "en-approvals.ts",
  "en-secrets-store.ts",
  "en-board-website.ts",
  "en-board.ts",
  "en-browser.ts",
  "en-chat-camera.ts",
  "en-chat-ci.ts",
  "en-chat-command-results.ts",
  "en-chat-composer.ts",
  "en-chat-details.ts",
  "en-chat-goals.ts",
  "en-chat-message-metadata.ts",
  "en-chat-media.ts",
  "en-chat-provider-review.ts",
  "en-chat-questions.ts",
  "en-chat-session.ts",
  "en-chat-tool-content.ts",
  "en-chat-tool-labels.ts",
  "en-claws.ts",
  "en-code-blocks.ts",
  "en-command-palette.ts",
  "en-connection-recovery.ts",
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
  "en-session-machine.ts",
  "en-session-navigation.ts",
  "en-session-organization-shared.ts",
  "en-session-organization.ts",
  "en-session-people.ts",
  "en-session-placement.ts",
  "en-new-session-runtime.ts",
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
  // Keep canonical translation order when summary copy moves out of the lazy CI catalog.
  const { automationNoChecks, ...pullRequests } = registerGitHubEnglish.catalog.chat.pullRequests;
  const { automationRetry, ...ciPullRequests } = registerChatCiEnglish.catalog.chat.pullRequests;
  const agentChip: TranslationMap = {};
  for (const [key, value] of Object.entries(en.agentChip)) {
    agentChip[key] = value;
    if (key === "creatingAgent") {
      Object.assign(agentChip, registerAgentCreationEnglish.catalog.agentChip);
    }
  }
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
  const sessionDetails: TranslationMap = {};
  for (const [key, value] of Object.entries(
    registerChatSessionEnglish.catalog.chat.sessionDetails,
  )) {
    sessionDetails[key] = value;
    if (key === "close") {
      Object.assign(sessionDetails, registerChatDetailsEnglish.catalog.chat.sessionDetails);
    }
  }
  const toolCards: TranslationMap = {};
  const toolContent = registerChatToolContentEnglish.catalog.chat.toolCards;
  for (const [key, value] of Object.entries(registerChatToolLabelsEnglish.catalog.chat.toolCards)) {
    toolCards[key] = value;
    const contentKeys: Array<keyof typeof toolContent> =
      key === "toolOutput"
        ? [
            "providerResponse",
            "executionOutput",
            "showFullOutput",
            "fullOutputUnavailable",
            "copyOutput",
            "downloadOutput",
            "outputLoadFailed",
            "outputDownloadFailed",
            "toolError",
          ]
        : key === "hideRawDetails"
          ? ["viewMode", "diff", "raw"]
          : key === "openFile"
            ? ["openDetails"]
            : key === "failureCount"
              ? ["noOutputFailed"]
              : [];
    for (const contentKey of contentKeys) {
      toolCards[contentKey] = toolContent[contentKey];
    }
  }
  const boardWidget: TranslationMap = {};
  for (const [key, value] of Object.entries(registerBoardDocumentEnglish.catalog.board.widget)) {
    boardWidget[key] = value;
    if (key === "remove") {
      Object.assign(boardWidget, registerBoardEnglish.catalog.board.widget);
    }
    if (key === "kindWebsite") {
      Object.assign(boardWidget, registerBoardWebsiteEnglish.catalog.board.widget);
    }
  }
  const chat: TranslationMap = {};
  for (const [key, value] of Object.entries(en.chat)) {
    const sourceKeys: Array<Exclude<keyof typeof registerSettingsEnglish.catalog.chat, "sidebar">> =
      key === "sendShortcutModifierEnter"
        ? ["sendShortcut", "sendShortcutHint", "sendShortcutEnter"]
        : key === "followUpModeSteer"
          ? ["followUpMode", "followUpModeQueue", "followUpModeServer", "followUpModeLoading"]
          : key === "catalogOutputTruncated"
            ? [
                "followUpModeOverriding",
                "followUpModeReset",
                "catalogOpenTarget",
                "catalogOpenTargetViewer",
                "catalogOpenTargetTerminal",
              ]
            : [];
    for (const sourceKey of sourceKeys) {
      chat[sourceKey] = registerSettingsEnglish.catalog.chat[sourceKey];
    }
    if (key === "actions") {
      chat.updating = registerUpdateActionsEnglish.catalog.chat.updating;
    }
    chat[key] = value;
  }
  const commandResults: TranslationMap = {};
  for (const [key, value] of Object.entries(en.chat.commandResults)) {
    if (key === "help") {
      for (const name of ["unknownCommand", "options", "sessionUnavailable"] as const) {
        commandResults[name] = registerChatCommandResultsEnglish.catalog.chat.commandResults[name];
      }
    }
    commandResults[key] = value;
  }
  const sidebar: TranslationMap = {};
  for (const [key, value] of Object.entries(en.chat.sidebar)) {
    if (key === "threads") {
      Object.assign(sidebar, registerUpdateActionsEnglish.catalog.chat.sidebar);
    }
    if (key === "catalogGroupByProject") {
      Object.assign(sidebar, registerSettingsEnglish.catalog.chat.sidebar);
    }
    sidebar[key] = value;
  }
  // Read fragment data without registering it into the shared runtime catalog.
  // en.ts's empty anchors retain source order for extracted whole subtrees.
  return mergeControlUiTranslationMaps(
    {
      skillDiscovery: registerSkillLibraryEnglish.catalog.skillDiscovery,
      skillLibrary: registerSkillLibraryEnglish.catalog.skillLibrary,
    },
    // Preserve partial-fragment key order while keeping shared labels eager.
    {
      ...en,
      subtitles: registerRouteSubtitlesEnglish.catalog.subtitles,
      languages: registerSettingsEnglish.catalog.languages,
      onboarding: registerMemoryImportEnglish.catalog.onboarding,
      execApproval: registerApprovalsEnglish.catalog.execApproval,
      browser: mergeControlUiTranslationMaps(en.browser, registerBrowserEnglish.catalog.browser),
      sessionProgressCard: registerSessionProgressEnglish.catalog.sessionProgressCard,
      assistantPanel: registerAssistantContextEnglish.catalog.assistantPanel,
      outputs: registerChatOutputsEnglish.catalog.outputs,
      nativeLinkMenu: registerNativeLinkMenuEnglish.catalog.nativeLinkMenu,
      capacityMeter: registerWorkerCapacityEnglish.catalog.capacityMeter,
      skillGroups: registerSkillLibraryEnglish.catalog.skillGroups,
      skillStatus: registerSkillLibraryEnglish.catalog.skillStatus,
      pluginUi: registerPluginManagementEnglish.catalog.pluginUi,
      labsPage: { ...en.labsPage, swarm: registerLabsEnglish.catalog.labsPage.swarm },
      aboutPage: registerAboutEnglish.catalog.aboutPage,
      dashboardsPage: registerDashboardsEnglish.catalog.dashboardsPage,
      worktrees: registerSessionOrganizationEnglish.catalog.worktrees,
      configForm: registerSettingsEnglish.catalog.configForm,
      configView: registerSettingsEnglish.catalog.configView,
      quickSettings: registerPreferencesEnglish.catalog.quickSettings,
      activityFeed: registerActivityEnglish.catalog.activityFeed,
      terminal: registerTerminalEnglish.catalog.terminal,
      updates: registerUpdateActionsEnglish.catalog.updates,
      agentChip,
      secretsStore: registerSecretsStoreEnglish.catalog.secretsStore,
      custodian: {
        ...registerPluginManagementEnglish.catalog.custodian,
        ...en.custodian,
        autoSetup: registerPluginManagementEnglish.catalog.custodian.autoSetup,
      },
      chat: {
        ...chat,
        sidebar,
        clawhub: registerPluginManagementEnglish.catalog.chat.clawhub,
        ...registerChatSessionEnglish.catalog.chat,
        ...registerSessionNavigationEnglish.catalog.chat,
        sessionDetails,
        sessionSuggestions: {
          ...registerSessionNavigationEnglish.catalog.chat.sessionSuggestions,
          ...registerChatSessionEnglish.catalog.chat.sessionSuggestions,
        },
        commandResults,
        commands: registerCommandPaletteEnglish.catalog.chat.commands,
        welcome: registerCommandPaletteEnglish.catalog.chat.welcome,
        messages: registerChatMessageMetadataEnglish.catalog.chat.messages,
        toolCards,
        systemNotice: registerChatMessageMetadataEnglish.catalog.chat.systemNotice,
        questions: registerChatQuestionsEnglish.catalog.chat.questions,
        imageLightbox: registerChatMediaEnglish.catalog.chat.imageLightbox,
        mediaPlayer: registerChatMediaEnglish.catalog.chat.mediaPlayer,
        attachments: registerChatComposerEnglish.catalog.chat.attachments,
        privateDraftReload: registerChatComposerEnglish.catalog.chat.privateDraftReload,
        pullRequests,
      },
      sessionHovercard: registerGitHubEnglish.catalog.sessionHovercard,
      githubPublication: registerGitHubEnglish.catalog.githubPublication,
      githubConnections: registerGitHubConnectionsEnglish.catalog.githubConnections,
      agentTools: {
        ...registerGitHubConnectionsEnglish.catalog.agentTools,
        ...en.agentTools,
        ...registerToolDiagnosticsEnglish.catalog.agentTools,
      },
      board: { ...registerBoardDocumentEnglish.catalog.board, widget: boardWidget },
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
    registerClawsEnglish.catalog,
    registerAppsEnglish.catalog,
    registerLogbookEnglish.catalog,
    registerLogsEnglish.catalog,
    registerApprovalsEnglish.catalog,
    registerSecretsStoreEnglish.catalog,
    registerBrowserEnglish.catalog,
    registerChatCameraEnglish.catalog,
    { chat: { pullRequests: { ...ciPullRequests, automationNoChecks, automationRetry } } },
    registerChatCommandResultsEnglish.catalog,
    registerChatComposerEnglish.catalog,
    registerChatGoalsEnglish.catalog,
    registerChatProviderReviewEnglish.catalog,
    registerCodeBlocksEnglish.catalog,
    registerConnectionRecoveryEnglish.catalog,
    registerCronEnglish.catalog,
    registerDevicesEnglish.catalog,
    registerDreamingEnglish.catalog,
    registerFilePreviewEnglish.catalog,
    registerProcessesEnglish.catalog,
    registerPreferencesEnglish.catalog,
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
    registerSessionMachineEnglish.catalog,
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
    registerTerminalEnglish.catalog,
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
