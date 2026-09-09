// Msteams API module exposes the plugin public contract.
export * from "./src/employee-onboarding-reset.js";
export * from "./src/employee-openai-auth-enrollment.js";
export { msteamsPlugin } from "./src/channel.js";
export { createMSTeamsSetupWizardBase, msteamsSetupAdapter } from "./src/setup-core.js";
export { msteamsSetupWizard, openDelegatedOAuthUrl } from "./src/setup-surface.js";
