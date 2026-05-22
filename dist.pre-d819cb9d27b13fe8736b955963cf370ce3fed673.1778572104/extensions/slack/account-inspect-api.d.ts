import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { t as InspectedSlackAccount } from "../../account-inspect-JTfJdE64.js";

//#region extensions/slack/account-inspect-api.d.ts
declare function inspectSlackReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedSlackAccount;
//#endregion
export { inspectSlackReadOnlyAccount };