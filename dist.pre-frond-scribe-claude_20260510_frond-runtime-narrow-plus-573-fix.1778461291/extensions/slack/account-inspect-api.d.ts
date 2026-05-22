import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { t as InspectedSlackAccount } from "../../account-inspect-AZptn62u.js";

//#region extensions/slack/account-inspect-api.d.ts
declare function inspectSlackReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedSlackAccount;
//#endregion
export { inspectSlackReadOnlyAccount };