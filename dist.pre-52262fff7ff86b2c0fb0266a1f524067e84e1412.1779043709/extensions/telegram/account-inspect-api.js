import { t as inspectTelegramAccount } from "../../account-inspect-Mzsd2vUW.js";
//#region extensions/telegram/account-inspect-api.ts
function inspectTelegramReadOnlyAccount(cfg, accountId) {
	return inspectTelegramAccount({
		cfg,
		accountId
	});
}
//#endregion
export { inspectTelegramReadOnlyAccount };
