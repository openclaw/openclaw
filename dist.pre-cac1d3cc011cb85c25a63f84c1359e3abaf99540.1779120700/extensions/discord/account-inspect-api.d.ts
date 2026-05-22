import { i as OpenClawConfig } from "../../types.openclaw-C58U02FA.js";
import { t as InspectedDiscordAccount } from "../../account-inspect-C2pCxUm8.js";

//#region extensions/discord/account-inspect-api.d.ts
declare function inspectDiscordReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedDiscordAccount;
//#endregion
export { inspectDiscordReadOnlyAccount };