import { t as inspectSlackAccount } from "../../account-inspect-G1nxeCTY.js";
//#region extensions/slack/account-inspect-api.ts
function inspectSlackReadOnlyAccount(cfg, accountId) {
	return inspectSlackAccount({
		cfg,
		accountId
	});
}
//#endregion
export { inspectSlackReadOnlyAccount };
