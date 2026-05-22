import { i as OpenClawConfig } from "../../types.openclaw-BdSNxnBz.js";
import { t as InspectedSlackAccount } from "../../account-inspect-BHXDCjxD.js";

//#region extensions/slack/account-inspect-api.d.ts
declare function inspectSlackReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedSlackAccount;
//#endregion
export { inspectSlackReadOnlyAccount };