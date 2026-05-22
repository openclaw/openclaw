import { a as resolveWhatsAppGroupToolPolicy, i as resolveWhatsAppGroupRequireMention, o as resolveWhatsAppGroupIntroHint, r as whatsappSetupWizardProxy, t as createWhatsAppPluginBase } from "./shared-xGT2whpy.js";
import { m as readWebAuthState } from "./auth-store-CGMuvA9j.js";
import { t as whatsappSetupAdapter } from "./setup-core-BPoe3Lho.js";
import { t as detectWhatsAppLegacyStateMigrations } from "./state-migrations-Ce1s5uq4.js";
//#region extensions/whatsapp/src/channel.setup.ts
const whatsappSetupPlugin = {
	...createWhatsAppPluginBase({
		groups: {
			resolveRequireMention: resolveWhatsAppGroupRequireMention,
			resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
			resolveGroupIntroHint: resolveWhatsAppGroupIntroHint
		},
		setupWizard: whatsappSetupWizardProxy,
		setup: whatsappSetupAdapter,
		isConfigured: async (account) => await readWebAuthState(account.authDir) === "linked"
	}),
	lifecycle: { detectLegacyStateMigrations: ({ oauthDir }) => detectWhatsAppLegacyStateMigrations({ oauthDir }) }
};
//#endregion
export { whatsappSetupPlugin as t };
