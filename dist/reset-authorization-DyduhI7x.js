import { r as isInternalMessageChannel } from "./message-channel-CYCKkVrh.js";
import { t as resolveCommandAuthorization } from "./command-auth-B6j-kluy.js";
//#region src/auto-reply/reply/reset-authorization.ts
function isResetAuthorizedForContext(params) {
	const auth = resolveCommandAuthorization(params);
	if (!params.commandAuthorized && !auth.isAuthorizedSender) return false;
	const provider = params.ctx.Provider;
	if (!(provider ? isInternalMessageChannel(provider) : isInternalMessageChannel(params.ctx.Surface))) return true;
	const scopes = params.ctx.GatewayClientScopes;
	if (!Array.isArray(scopes) || scopes.length === 0) return true;
	return scopes.includes("operator.admin");
}
//#endregion
export { isResetAuthorizedForContext as t };
