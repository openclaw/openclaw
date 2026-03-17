import {
  buildChannelConfigSchema,
  IMessageConfigSchema,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/imessage";
import { type ResolvedIMessageAccount } from "./accounts.js";
import { imessageSetupAdapter } from "./setup-core.js";
import { createIMessagePluginBase, imessageSetupWizard } from "./shared.js";

export const imessageSetupPlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  ...createIMessagePluginBase({
    configSchema: buildChannelConfigSchema(IMessageConfigSchema),
    setupWizard: imessageSetupWizard,
    setup: imessageSetupAdapter,
  }),
};
