import { setSetupChannelEnabled, type ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { listIMessageAccountIds, resolveIMessageAccount } from "./accounts.js";
import {
  createIMessageCliPathTextInput,
  imessageCompletionNote,
  imessageDmPolicy,
  imessageSetupAdapter,
  imessageSetupStatusBase,
  parseIMessageAllowFromEntries,
} from "./setup-core.js";

const channel = "imessage" as const;

export const imessageSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    ...imessageSetupStatusBase,
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
