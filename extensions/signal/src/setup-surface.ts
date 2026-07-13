// Signal plugin module implements setup surface behavior.
import {
  createSetupTranslator,
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";
import {
  createSignalCliPathTextInput,
  finalizeSignalSetupWizard,
  prepareSignalSetupWizard,
  resolveSignalSetupTransportFromCredentialValues,
  signalDmPolicy,
  signalNumberTextInput,
} from "./setup-core.js";

const t = createSetupTranslator();

const channel = "signal" as const;
function isSignalSetupConfigured(params: {
  cfg: Parameters<typeof listSignalAccountIds>[0];
  accountId?: string;
}) {
  const account = resolveSignalAccount(params);
  return account.config.apiMode === "container"
    ? Boolean(normalizeOptionalString(account.config.account))
    : account.configured;
}

function hasAnyConfiguredSignalSetup(cfg: Parameters<typeof listSignalAccountIds>[0]) {
  return listSignalAccountIds(cfg).some((accountId) => isSignalSetupConfigured({ cfg, accountId }));
}

const nativeSignalStatus = createDetectedBinaryStatus({
  channelLabel: "Signal",
  binaryLabel: "signal-cli",
  configuredLabel: t("wizard.channels.statusConfigured"),
  unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
  configuredHint: t("wizard.channels.statusSignalCliFound"),
  unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
  configuredScore: 1,
  unconfiguredScore: 0,
  resolveConfigured: ({ cfg, accountId }) =>
    accountId ? isSignalSetupConfigured({ cfg, accountId }) : hasAnyConfiguredSignalSetup(cfg),
  resolveBinaryPath: ({ cfg, accountId }) =>
    resolveSignalAccount({ cfg, accountId }).config.cliPath ?? "signal-cli",
  detectBinary,
});

function resolveSetupStatusTransport(params: {
  cfg: Parameters<typeof listSignalAccountIds>[0];
  accountId?: string;
}) {
  return resolveSignalSetupTransportFromCredentialValues({
    cfg: params.cfg,
    accountId: params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
    credentialValues: {},
  });
}

export const signalSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
    configuredHint: t("wizard.channels.statusSignalCliFound"),
    unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg, accountId }) =>
      accountId ? isSignalSetupConfigured({ cfg, accountId }) : hasAnyConfiguredSignalSetup(cfg),
    async resolveStatusLines(params) {
      const transport = resolveSetupStatusTransport(params);
      if (transport === "native") {
        return (await nativeSignalStatus.resolveStatusLines?.(params)) ?? [];
      }
      const label = params.configured
        ? t("wizard.channels.statusConfigured")
        : t("wizard.channels.statusNeedsSetup");
      return [`Signal: ${label}`, "Signal transport: existing Signal server"];
    },
    async resolveSelectionHint(params) {
      const transport = resolveSetupStatusTransport(params);
      if (transport === "native") {
        return await nativeSignalStatus.resolveSelectionHint?.(params);
      }
      return params.configured
        ? t("wizard.channels.statusConfigured")
        : t("wizard.channels.statusNeedsSetup");
    },
    async resolveQuickstartScore(params) {
      const transport = resolveSetupStatusTransport(params);
      if (transport === "native") {
        return await nativeSignalStatus.resolveQuickstartScore?.(params);
      }
      return params.configured ? 1 : 0;
    },
  },
  prepare: prepareSignalSetupWizard,
  credentials: [],
  textInputs: [
    createSignalCliPathTextInput(async ({ cfg, accountId, credentialValues, currentValue }) => {
      const transport = resolveSignalSetupTransportFromCredentialValues({
        cfg,
        accountId,
        credentialValues,
      });
      if (transport !== "native") {
        return false;
      }
      return !(await detectBinary(currentValue ?? "signal-cli"));
    }),
    signalNumberTextInput,
  ],
  finalize: finalizeSignalSetupWizard,
  dmPolicy: signalDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
