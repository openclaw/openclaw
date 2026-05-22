import { t as inspectTelegramAccount } from "../../account-inspect-D0DDZmpA.js";
//#region extensions/telegram/account-inspect-api.ts
function inspectTelegramReadOnlyAccount(cfg, accountId) {
	return inspectTelegramAccount({
		cfg,
		accountId
	});
}
//#endregion
export { inspectTelegramReadOnlyAccount };
