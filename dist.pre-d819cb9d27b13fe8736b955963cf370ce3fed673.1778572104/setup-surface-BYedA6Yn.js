import "./account-id-9_btbLFO.js";
import { J as setSetupChannelEnabled } from "./setup-wizard-helpers-BEHncM17.js";
import "./setup-DODH2Khc.js";
import { t as listAccountIds } from "./account-ids-DjuAU7E6.js";
import { o as resolveWhatsAppAuthDir } from "./accounts-DyY9IjH9.js";
import { i as formatWhatsAppWebAuthStatusState, m as readWebAuthState } from "./auth-store-fIu0IuAh.js";
//#region extensions/whatsapp/src/setup-surface.ts
const channel = "whatsapp";
async function readWhatsAppSetupLinkState(cfg, accountId) {
	const { authDir } = resolveWhatsAppAuthDir({
		cfg,
		accountId
	});
	return await readWebAuthState(authDir);
}
const whatsappSetupWizard = {
	channel,
	status: {
		configuredLabel: "linked",
		unconfiguredLabel: "not linked",
		configuredHint: "linked",
		unconfiguredHint: "not linked",
		configuredScore: 5,
		unconfiguredScore: 4,
		resolveConfigured: async ({ cfg, accountId }) => {
			for (const resolvedAccountId of accountId ? [accountId] : listAccountIds(cfg)) if (await readWhatsAppSetupLinkState(cfg, resolvedAccountId) === "linked") return true;
			return false;
		},
		resolveStatusLines: async ({ cfg, accountId, configured }) => {
			const linkedAccountId = (await Promise.all((accountId ? [accountId] : listAccountIds(cfg)).map(async (resolvedAccountId) => ({
				accountId: resolvedAccountId,
				state: await readWhatsAppSetupLinkState(cfg, resolvedAccountId)
			})))).find((entry) => entry.state === "linked" || entry.state === "unstable");
			const labelAccountId = accountId ?? linkedAccountId?.accountId;
			return [`${labelAccountId ? `WhatsApp (${labelAccountId === "default" ? "default" : labelAccountId})` : "WhatsApp"}: ${configured ? formatWhatsAppWebAuthStatusState("linked") : formatWhatsAppWebAuthStatusState(linkedAccountId?.state ?? "not-linked")}`];
		}
	},
	resolveShouldPromptAccountIds: ({ shouldPromptAccountIds }) => shouldPromptAccountIds,
	credentials: [],
	finalize: async (params) => await (await import("./setup-finalize-DAeKYNn2.js")).finalizeWhatsAppSetup(params),
	disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
	onAccountRecorded: (accountId, options) => {
		options?.onAccountId?.(channel, accountId);
	}
};
//#endregion
export { whatsappSetupWizard as t };
