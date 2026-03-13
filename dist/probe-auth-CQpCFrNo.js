import { Dh as isGatewaySecretRefUnavailableError, Jp as GATEWAY_CLIENT_MODES, Yp as GATEWAY_CLIENT_NAMES, _c as READ_SCOPE, kh as resolveGatewayProbeCredentialsFromConfig, pc as resolveGatewayCredentialsWithSecretInputs, xc as GatewayClient } from "./auth-profiles-CAw5gP6f.js";
import { o as formatErrorMessage } from "./cli-utils-Cikq4_a8.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/probe.ts
async function probeGateway(opts) {
	const startedAt = Date.now();
	const instanceId = randomUUID();
	let connectLatencyMs = null;
	let connectError = null;
	let close = null;
	return await new Promise((resolve) => {
		let settled = false;
		const settle = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.stop();
			resolve({
				url: opts.url,
				...result
			});
		};
		const client = new GatewayClient({
			url: opts.url,
			token: opts.auth?.token,
			password: opts.auth?.password,
			scopes: [READ_SCOPE],
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			clientVersion: "dev",
			mode: GATEWAY_CLIENT_MODES.PROBE,
			instanceId,
			onConnectError: (err) => {
				connectError = formatErrorMessage(err);
			},
			onClose: (code, reason) => {
				close = {
					code,
					reason
				};
			},
			onHelloOk: async () => {
				connectLatencyMs = Date.now() - startedAt;
				try {
					const [health, status, presence, configSnapshot] = await Promise.all([
						client.request("health"),
						client.request("status"),
						client.request("system-presence"),
						client.request("config.get", {})
					]);
					settle({
						ok: true,
						connectLatencyMs,
						error: null,
						close,
						health,
						status,
						presence: Array.isArray(presence) ? presence : null,
						configSnapshot
					});
				} catch (err) {
					settle({
						ok: false,
						connectLatencyMs,
						error: formatErrorMessage(err),
						close,
						health: null,
						status: null,
						presence: null,
						configSnapshot: null
					});
				}
			}
		});
		const timer = setTimeout(() => {
			settle({
				ok: false,
				connectLatencyMs,
				error: connectError ? `connect failed: ${connectError}` : "timeout",
				close,
				health: null,
				status: null,
				presence: null,
				configSnapshot: null
			});
		}, Math.max(250, opts.timeoutMs));
		client.start();
	});
}
//#endregion
//#region src/gateway/probe-auth.ts
function buildGatewayProbeCredentialPolicy(params) {
	return {
		config: params.cfg,
		cfg: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		modeOverride: params.mode,
		mode: params.mode,
		includeLegacyEnv: false,
		remoteTokenFallback: "remote-only"
	};
}
function resolveGatewayProbeAuth(params) {
	return resolveGatewayProbeCredentialsFromConfig(buildGatewayProbeCredentialPolicy(params));
}
async function resolveGatewayProbeAuthWithSecretInputs(params) {
	const policy = buildGatewayProbeCredentialPolicy(params);
	return await resolveGatewayCredentialsWithSecretInputs({
		config: policy.config,
		env: policy.env,
		explicitAuth: policy.explicitAuth,
		modeOverride: policy.modeOverride,
		includeLegacyEnv: policy.includeLegacyEnv,
		remoteTokenFallback: policy.remoteTokenFallback
	});
}
async function resolveGatewayProbeAuthWithSecretInputs(params) {
	return await resolveGatewayCredentialsWithSecretInputs({
		config: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		modeOverride: params.mode,
		includeLegacyEnv: false,
		remoteTokenFallback: "remote-only"
	});
}
function resolveGatewayProbeAuthSafe(params) {
	try {
		return { auth: resolveGatewayProbeAuth(params) };
	} catch (error) {
		if (!isGatewaySecretRefUnavailableError(error)) throw error;
		return {
			auth: {},
			warning: `${error.path} SecretRef is unresolved in this command path; probing without configured auth credentials.`
		};
	}
}
//#endregion
export { resolveGatewayProbeAuthWithSecretInputs as n, probeGateway as r, resolveGatewayProbeAuthSafe as t };
