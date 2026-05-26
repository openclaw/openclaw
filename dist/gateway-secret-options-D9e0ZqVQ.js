import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as readSecretFromFile } from "./secret-file-UFPEBo9z.js";
//#region src/cli/gateway-secret-options.ts
function resolveGatewaySecretOption(params) {
	const direct = normalizeOptionalString(params.direct);
	const file = normalizeOptionalString(params.file);
	if (direct && file) throw new Error(`Use either ${params.directFlag} or ${params.fileFlag} for ${params.label}.`);
	if (file) return readSecretFromFile(file, params.label);
	return direct || void 0;
}
function warnGatewaySecretCliFlag(flag) {
	defaultRuntime.error(`Warning: ${flag} can be exposed via process listings. Prefer ${flag}-file or environment variables.`);
}
function resolveGatewayAuthOptions(opts) {
	const gatewayToken = resolveGatewaySecretOption({
		direct: opts.token,
		file: opts.tokenFile,
		directFlag: "--token",
		fileFlag: "--token-file",
		label: "Gateway token"
	});
	const gatewayPassword = resolveGatewaySecretOption({
		direct: opts.password,
		file: opts.passwordFile,
		directFlag: "--password",
		fileFlag: "--password-file",
		label: "Gateway password"
	});
	if (opts.token) warnGatewaySecretCliFlag("--token");
	if (opts.password) warnGatewaySecretCliFlag("--password");
	return {
		gatewayToken,
		gatewayPassword
	};
}
//#endregion
export { resolveGatewayAuthOptions as t };
