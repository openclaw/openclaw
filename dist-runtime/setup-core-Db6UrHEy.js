import { s as init_session_key, v as normalizeAccountId } from "./session-key-BSZsryCD.js";
import { Hr as applyAccountNameToChannelSection, Wr as migrateBaseNameToDefaultAccount } from "./resolve-route-CQsiaDZO.js";
//#region extensions/whatsapp/src/setup-core.ts
init_session_key();
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
