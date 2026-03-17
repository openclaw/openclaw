import { discordSetupWizard as discordSetupWizardImpl } from "./setup-surface.js";

type DiscordSetupWizard = typeof import("./setup-surface.js").discordSetupWizard;

export const discordSetupWizard: DiscordSetupWizard = { ...discordSetupWizardImpl };
