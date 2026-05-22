import { t as inspectSlackAccount } from "../../account-inspect-Bdz8YL6e.js";
//#region extensions/slack/account-inspect-api.ts
function inspectSlackReadOnlyAccount(cfg, accountId) {
	return inspectSlackAccount({
		cfg,
		accountId
	});
}
//#endregion
export { inspectSlackReadOnlyAccount };
