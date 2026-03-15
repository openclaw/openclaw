import { HS as applyAccountNameToChannelSection, WS as migrateBaseNameToDefaultAccount } from "./auth-profiles-DqxBs6Au.js";
import { n as normalizeAccountId } from "./account-id-CYKfwqh7.js";
//#region extensions/whatsapp/src/setup-core.ts
const channel = "whatsapp";
const whatsappSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel,
		accountId,
		name,
		alwaysUseAccounts: true
	}),
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const next = migrateBaseNameToDefaultAccount({
			cfg: applyAccountNameToChannelSection({
				cfg,
				channelKey: channel,
				accountId,
				name: input.name,
				alwaysUseAccounts: true
			}),
			channelKey: channel,
			alwaysUseAccounts: true
		});
		const entry = {
			...next.channels?.whatsapp?.accounts?.[accountId],
			...input.authDir ? { authDir: input.authDir } : {},
			enabled: true
		};
		return {
			...next,
			channels: {
				...next.channels,
				whatsapp: {
					...next.channels?.whatsapp,
					accounts: {
						...next.channels?.whatsapp?.accounts,
						[accountId]: entry
					}
				}
			}
		};
	}
};
//#endregion
export { whatsappSetupAdapter as t };
