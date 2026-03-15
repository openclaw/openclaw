import { g as normalizeAccountId } from "./session-key-BfFG0xOA.js";
import { dr as applyAccountNameToChannelSection, pr as migrateBaseNameToDefaultAccount } from "./resolve-route-BZ4hHpx2.js";
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
