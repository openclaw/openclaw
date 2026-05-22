import { t as inspectSlackAccount } from "../../account-inspect-dETBdO_I.js";
//#region extensions/slack/account-inspect-api.ts
function inspectSlackReadOnlyAccount(cfg, accountId) {
	return inspectSlackAccount({
		cfg,
		accountId
	});
}
//#endregion
export { inspectSlackReadOnlyAccount };
