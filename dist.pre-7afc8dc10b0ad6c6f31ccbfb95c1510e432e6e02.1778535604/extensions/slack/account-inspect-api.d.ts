import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { t as InspectedSlackAccount } from "../../account-inspect-BkPLohDh.js";

//#region extensions/slack/account-inspect-api.d.ts
declare function inspectSlackReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedSlackAccount;
//#endregion
export { inspectSlackReadOnlyAccount };