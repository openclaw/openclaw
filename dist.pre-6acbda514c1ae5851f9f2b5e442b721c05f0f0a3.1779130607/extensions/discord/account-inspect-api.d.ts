import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { t as InspectedDiscordAccount } from "../../account-inspect-BEFZIxJn.js";

//#region extensions/discord/account-inspect-api.d.ts
declare function inspectDiscordReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedDiscordAccount;
//#endregion
export { inspectDiscordReadOnlyAccount };