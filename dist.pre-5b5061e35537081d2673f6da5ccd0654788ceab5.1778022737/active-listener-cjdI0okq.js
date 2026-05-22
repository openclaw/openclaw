import { r as resolveDefaultWhatsAppAccountId } from "./account-ids-lYmFPmeM.js";
import { t as getRegisteredWhatsAppConnectionController } from "./connection-controller-registry-BH5fzKn9.js";
//#region extensions/whatsapp/src/active-listener.ts
function resolveWebAccountId(params) {
	return (params.accountId ?? "").trim() || resolveDefaultWhatsAppAccountId(params.cfg);
}
function getActiveWebListener(accountId) {
	return getRegisteredWhatsAppConnectionController(accountId)?.getActiveListener() ?? null;
}
//#endregion
export { resolveWebAccountId as n, getActiveWebListener as t };
