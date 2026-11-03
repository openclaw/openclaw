/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import type { ControlUiSettingsContextV2 } from "openclaw/plugin-sdk/control-ui";
import { createComponent } from "solid-js";
import { showConfirmDialog } from "../../../../ui/src/components/confirm-dialog.ts";
import { handleCopyButton } from "../../../../ui/src/components/copy-button-state.ts";
import { t } from "../../../../ui/src/i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../../../ui/src/lib/format-error.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../../../../ui/src/lib/format.ts";
import { projectOwner } from "../../../../ui/src/lib/reactive/projection.ts";
import { registerControlUiEnglish } from "../../../../ui/src/plugins/control-ui-english.ts";
import { createControlUiSettingsComponents } from "../../../../ui/src/plugins/control-ui-settings-components.solid.tsx";
import { GitHubConnectionError as GitHubConnectionErrorView } from "../github-identity-view.tsx";
import {
  GitHubIdentityView,
  GitHubConnectionSetupView,
  SettingsContext,
  settingsEnglish as english,
} from "../index.tsx";
registerControlUiEnglish(english);
function settingsTestContext(
  overrides: Partial<ControlUiSettingsContextV2> = {},
): ControlUiSettingsContextV2 {
  const signal = new AbortController().signal;
  return {
    apiVersion: 2,
    readConfig: () => undefined,
    signal,
    props: {
      agentId: "main",
      configAvailable: false,
      agentsLoading: false,
      agentsError: null,
      connected: true,
      connectionEpoch: 0,
      routeIntent: "test",
      locale: "en",
    },
    components: createControlUiSettingsComponents(signal),
    registerEnglish: () => {},
    ensureConfig: async () => {},
    runConfigMutation: async () => ({ ok: false, reason: "unavailable", error: "Not configured" }),
    request: async () => {
      throw new Error("Unexpected Settings request");
    },
    navigate: () => {},
    navigateTo: () => {},
    refreshAgents: () => {},
    copyButton: handleCopyButton,
    projectOwner: (source) => projectOwner(source, (owner) => owner.read()),
    confirm: showConfirmDialog,
    translate: t,
    formatExternalText: formatUiExternalText,
    formatDateTime: formatDateTimeMs,
    formatError: formatUiError,
    formatRelativeTimestamp,
    ...overrides,
  };
}
function present<P extends object>(component: (props: P) => JSX.Element, props: P) {
  return createComponent(SettingsContext, {
    value: settingsTestContext(),
    get children() {
      return createComponent(component, props);
    },
  });
}
export function GitHubIdentity(props: Parameters<typeof GitHubIdentityView>[0]) {
  return present(GitHubIdentityView, props);
}
export function GitHubConnectionSetup(props: Parameters<typeof GitHubConnectionSetupView>[0]) {
  return present(GitHubConnectionSetupView, props);
}

export function GitHubConnectionError(props: Parameters<typeof GitHubConnectionErrorView>[0]) {
  return present(GitHubConnectionErrorView, props);
}
