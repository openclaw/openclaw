import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { d as normalizeSecretInputString, m as resolveSecretInputRef } from "./types.secrets-DYAh0rlj.js";
//#region src/gateway/auth-token-source-conflict.ts
const GATEWAY_ENV_TOKEN = "OPENCLAW_GATEWAY_TOKEN";
function resolveGatewayAuthTokenSourceConflict(params) {
	const envToken = normalizeOptionalString(params.env.OPENCLAW_GATEWAY_TOKEN);
	if (!envToken) return null;
	if (params.cfg.gateway?.mode === "remote") return null;
	const authMode = params.cfg.gateway?.auth?.mode;
	if (authMode === "password" || authMode === "none" || authMode === "trusted-proxy") return null;
	const tokenInput = params.cfg.gateway?.auth?.token;
	const { ref } = resolveSecretInputRef({
		value: tokenInput,
		defaults: params.cfg.secrets?.defaults
	});
	if (ref?.source === "env" && ref.id === GATEWAY_ENV_TOKEN) return null;
	const configToken = ref ? void 0 : normalizeSecretInputString(tokenInput);
	if (!ref && !configToken) return null;
	if (configToken === envToken) return null;
	const title = `${GATEWAY_ENV_TOKEN} overrides gateway.auth.token for CLI commands`;
	const detail = `${GATEWAY_ENV_TOKEN} is set while gateway.auth.token uses a different configured source. CLI commands use env-first precedence, but the gateway server uses config-first precedence. If the values differ, CLI commands can fail to authenticate with the running gateway.`;
	const remediation = `Remove ${GATEWAY_ENV_TOKEN} from the shell if gateway.auth.token is intended, or point gateway.auth.token at the same env source if the env var should be canonical.`;
	return {
		checkId: "gateway.env_token_overrides_config",
		title,
		detail,
		remediation,
		warningLines: [
			`- WARNING: ${title}.`,
			`  ${detail}`,
			`  Fix: ${remediation}`
		],
		diagnostic: `${title}: ${remediation}`
	};
}
//#endregion
export { resolveGatewayAuthTokenSourceConflict as t };
