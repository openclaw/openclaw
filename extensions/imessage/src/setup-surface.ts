import { detectBinary } from "../../../src/commands/onboard-helpers.js";
import { setSetupChannelEnabled } from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { listIMessageAccountIds, resolveIMessageAccount } from "./accounts.js";
import {
  createIMessageCliPathTextInput,
  imessageCompletionNote,
  imessageDmPolicy,
  imessageSetupAdapter,
  parseIMessageAllowFromEntries,
} from "./setup-core.js";

const channel = "imessage" as const;

export const imessageSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    configuredHint: "imsg found",
    unconfiguredHint: "imsg missing",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) =>
      listIMessageAccountIds(cfg).some((accountId) => {
        const account = resolveIMessageAccount({ cfg, accountId });
        return Boolean(
          account.config.cliPath ||
          account.config.dbPath ||
          account.config.allowFrom ||
          account.config.service ||
          account.config.region,
        );
      }),
    resolveStatusLines: async ({ cfg, configured }) => {
      const cliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
      const cliDetected = await detectBinary(cliPath);
      return [
        `iMessage: ${configured ? "configured" : "needs setup"}`,
        `imsg: ${cliDetected ? "found" : "missing"} (${cliPath})`,
      ];
    },
    resolveSelectionHint: async ({ cfg }) => {
      const cliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
      return (await detectBinary(cliPath)) ? "imsg found" : "imsg missing";
    },
    resolveQuickstartScore: async ({ cfg }) => {
      const cliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
      return (await detectBinary(cliPath)) ? 1 : 0;
    },
  },
  credentials: [],
  textInputs: [
    createIMessageCliPathTextInput(async ({ currentValue }) => {
      return !(await detectBinary(currentValue ?? "imsg"));
    }),
  ],
  completionNote: imessageCompletionNote,
  dmPolicy: imessageDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { imessageSetupAdapter, parseIMessageAllowFromEntries };
