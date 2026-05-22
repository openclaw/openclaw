import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { t as InspectedSlackAccount } from "../../account-inspect-Cs63U_Qn.js";

//#region extensions/slack/account-inspect-api.d.ts
declare function inspectSlackReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedSlackAccount;
//#endregion
export { inspectSlackReadOnlyAccount };