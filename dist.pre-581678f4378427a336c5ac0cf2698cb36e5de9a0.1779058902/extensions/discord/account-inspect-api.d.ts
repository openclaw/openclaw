import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { t as InspectedDiscordAccount } from "../../account-inspect-CI06JGmd.js";

//#region extensions/discord/account-inspect-api.d.ts
declare function inspectDiscordReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedDiscordAccount;
//#endregion
export { inspectDiscordReadOnlyAccount };