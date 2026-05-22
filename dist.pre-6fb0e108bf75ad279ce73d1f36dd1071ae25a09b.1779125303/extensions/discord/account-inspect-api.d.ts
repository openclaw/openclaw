import { i as OpenClawConfig } from "../../types.openclaw-DBDmmaVM.js";
import { t as InspectedDiscordAccount } from "../../account-inspect-B6tZgzg-.js";

//#region extensions/discord/account-inspect-api.d.ts
declare function inspectDiscordReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedDiscordAccount;
//#endregion
export { inspectDiscordReadOnlyAccount };