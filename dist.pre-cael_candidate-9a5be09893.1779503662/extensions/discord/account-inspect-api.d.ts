import { i as OpenClawConfig } from "../../types.openclaw-BorXMoYB.js";
import { t as InspectedDiscordAccount } from "../../account-inspect-BHZa7MbB.js";

//#region extensions/discord/account-inspect-api.d.ts
declare function inspectDiscordReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null): InspectedDiscordAccount;
//#endregion
export { inspectDiscordReadOnlyAccount };