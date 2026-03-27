import type { ChannelPlugin } from "../runtime-api.js";
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
