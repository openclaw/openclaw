// Signal plugin module implements setup surface behavior.
import {
  createSetupTranslator,
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { signalCompletionNote, signalDmPolicy, signalNumberTextInputs } from "./setup-core.js";
import {
  finalizeSignalInteractiveSetup,
  prepareSignalInteractiveSetup,
} from "./setup-interactive.js";

const t = createSetupTranslator();

const channel = "signal" as const;
const configuredLabel = t("wizard.channels.statusConfigured");
const unconfiguredLabel = t("wizard.channels.statusNeedsSetup");
const managedStatus = createDetectedBinaryStatus({
  channelLabel: "Signal",
  binaryLabel: "signal-cli",
  configuredLabel,
  unconfiguredLabel,
  configuredHint: t("wizard.channels.statusSignalCliFound"),
  unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
  configuredScore: 1,
  unconfiguredScore: 0,
  resolveConfigured: ({ cfg, accountId }) =>
    accountId
      ? resolveSignalAccount({ cfg, accountId }).configured
      : listSignalAccountIds(cfg).some(
          (resolvedAccountId) =>
            resolveSignalAccount({ cfg, accountId: resolvedAccountId }).configured,
        ),
  resolveBinaryPath: ({ cfg, accountId }) => {
    const transport = resolveSignalAccount({ cfg, accountId }).transport;
    return transport.kind === "managed-native" ? transport.cliPath : "signal-cli";
  },
  detectBinary,
});

export const signalSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    ...managedStatus,
    resolveStatusLines: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return (await managedStatus.resolveStatusLines?.(params)) ?? [];
      }
      return [`Signal: ${params.configured ? configuredLabel : unconfiguredLabel}`];
    },
    resolveSelectionHint: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return await managedStatus.resolveSelectionHint?.(params);
      }
      return params.configured ? configuredLabel : unconfiguredLabel;
    },
    resolveQuickstartScore: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return await managedStatus.resolveQuickstartScore?.(params);
      }
      return params.configured ? 1 : 0;
    },
  },
  introNote: {
    title: "Signal",
    lines: [
      "Signal uses a real Signal account/device, not a bot token.",
      "A dedicated Signal number is recommended for bot-like operation.",
    ],
  },
  prepare: prepareSignalInteractiveSetup,
  credentials: [],
  textInputs: signalNumberTextInputs,
  finalize: finalizeSignalInteractiveSetup,
  completionNote: signalCompletionNote,
  dmPolicy: signalDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
