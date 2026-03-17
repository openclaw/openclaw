import { type ChannelPlugin } from "../../../src/plugin-sdk-internal/imessage.js";
import { type ResolvedIMessageAccount } from "./accounts.js";
import { createIMessageSetupWizardProxy } from "./setup-core.js";

async function loadIMessageChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const imessageSetupWizard = createIMessageSetupWizardProxy(async () => ({
  imessageSetupWizard: (await loadIMessageChannelRuntime()).imessageSetupWizard,
})) satisfies NonNullable<ChannelPlugin<ResolvedIMessageAccount>["setupWizard"]>;
