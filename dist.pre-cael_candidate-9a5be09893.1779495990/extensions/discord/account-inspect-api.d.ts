import { i as OpenClawConfig } from "../../types.openclaw-GamulG8g.js";
import { t as InspectedDiscordAccount } from "../../account-inspect-CNmUnL7Y.js";

//#region extensions/discord/account-inspect-api.d.ts
declare function inspectDiscordReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedDiscordAccount;
//#endregion
export { inspectDiscordReadOnlyAccount };