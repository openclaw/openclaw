import { n as normalizeAccountId } from "../../account-id-Bj7l9NI7.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CESD8ZBk.js";
import "../../setup-C4H6GH6R.js";
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
