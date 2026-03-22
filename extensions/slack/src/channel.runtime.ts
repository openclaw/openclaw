import { slackSetupWizard as slackSetupWizardImpl } from "./setup-surface.js";

type SlackSetupWizard = typeof import("./setup-surface.js").slackSetupWizard;

export const slackSetupWizard: SlackSetupWizard = { ...slackSetupWizardImpl };
