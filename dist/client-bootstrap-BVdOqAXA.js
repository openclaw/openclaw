import { t as buildGatewayConnectionDetailsWithResolvers } from "./connection-details-BUwiTtDD.js";
import { t as resolveGatewayConnectionAuth } from "./connection-auth-D13AOF2W.js";
//#region src/gateway/client-bootstrap.ts
function resolveGatewayUrlOverrideSource(urlSource) {
	if (urlSource === "cli --url") return "cli";
	if (urlSource === "env OPENCLAW_GATEWAY_URL") return "env";
}
async function resolveGatewayClientBootstrap(params) {
	const connection = buildGatewayConnectionDetailsWithResolvers({
		config: params.config,
		url: params.gatewayUrl
	});
	const urlOverrideSource = resolveGatewayUrlOverrideSource(connection.urlSource);
	const auth = await resolveGatewayConnectionAuth({
		config: params.config,
		explicitAuth: params.explicitAuth,
		env: params.env ?? process.env,
		urlOverride: urlOverrideSource ? connection.url : void 0,
		urlOverrideSource
	});
	return {
		url: connection.url,
		urlSource: connection.urlSource,
		preauthHandshakeTimeoutMs: params.config.gateway?.handshakeTimeoutMs,
		auth
	};
}
//#endregion
export { resolveGatewayUrlOverrideSource as n, resolveGatewayClientBootstrap as t };
