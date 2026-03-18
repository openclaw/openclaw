import { discordSetupWizard as discordSetupWizardImpl } from "./setup-surface.ts";

type DiscordSetupWizard = typeof import("./setup-surface.ts").discordSetupWizard;

export const discordSetupWizard: DiscordSetupWizard = { ...discordSetupWizardImpl };
