import { detectBinary } from "../../../src/plugin-sdk-internal/setup.js";
import { createIMessageSetupWizardBase, imessageSetupAdapter } from "./setup-core.js";

export const imessageSetupWizard = createIMessageSetupWizardBase({
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
  shouldPromptCliPath: async ({ currentValue }) => !(await detectBinary(currentValue ?? "imsg")),
});
export { imessageSetupAdapter, parseIMessageAllowFromEntries } from "./setup-core.js";
