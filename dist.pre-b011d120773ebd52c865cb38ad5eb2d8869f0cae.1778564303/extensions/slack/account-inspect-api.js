import { t as inspectSlackAccount } from "../../account-inspect-B3rLVv_0.js";
//#region extensions/slack/account-inspect-api.ts
function inspectSlackReadOnlyAccount(cfg, accountId) {
	return inspectSlackAccount({
		cfg,
		accountId
	});
}
//#endregion
export { inspectSlackReadOnlyAccount };
