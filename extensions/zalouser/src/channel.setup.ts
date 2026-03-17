import type { ChannelPlugin } from "openclaw/plugin-sdk/zalouser";
import type { ResolvedZalouserAccount } from "./accounts.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { createZalouserPluginBase } from "./shared.js";

export const zalouserSetupPlugin: ChannelPlugin<ResolvedZalouserAccount> = {
  ...createZalouserPluginBase({
    setupWizard: zalouserSetupWizard,
    setup: zalouserSetupAdapter,
  }),
};
