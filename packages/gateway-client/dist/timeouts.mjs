//#region packages/gateway-client/src/timeouts.ts
function parseStrictPositiveInteger(value) {
	if (!/^[1-9]\d*$/u.test(value)) return;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : void 0;
}
const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15e3;
const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
function clampConnectChallengeTimeoutMs(timeoutMs, maxTimeoutMs = MAX_CONNECT_CHALLENGE_TIMEOUT_MS) {
	return Math.max(250, Math.min(Math.max(250, maxTimeoutMs), timeoutMs));
}
function getConnectChallengeTimeoutMsFromEnv(env = process.env) {
	const raw = env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
	if (raw) {
		const parsed = parseStrictPositiveInteger(raw);
		if (parsed !== void 0) return parsed;
	}
}
function normalizePositiveTimeoutMs(timeoutMs) {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : void 0;
}
function resolveConnectChallengeTimeoutMs(timeoutMs, params) {
	const configuredPreauthTimeoutMs = resolvePreauthHandshakeTimeoutMs({
		env: params?.env,
		configuredTimeoutMs: params?.configuredTimeoutMs
	});
	const maxTimeoutMs = Math.max(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS, configuredPreauthTimeoutMs);
	if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) return clampConnectChallengeTimeoutMs(timeoutMs, maxTimeoutMs);
	const envOverride = getConnectChallengeTimeoutMsFromEnv(params?.env);
	if (envOverride !== void 0) return clampConnectChallengeTimeoutMs(envOverride, Math.max(maxTimeoutMs, envOverride));
	return clampConnectChallengeTimeoutMs(configuredPreauthTimeoutMs, maxTimeoutMs);
}
function getPreauthHandshakeTimeoutMsFromEnv(env = process.env) {
	const configuredTimeout = env.OPENCLAW_HANDSHAKE_TIMEOUT_MS || env.VITEST && env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
	if (configuredTimeout) {
		const parsed = parseStrictPositiveInteger(configuredTimeout);
		if (parsed !== void 0) return parsed;
	}
	return DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
}
function resolvePreauthHandshakeTimeoutMs(params) {
	const env = params?.env ?? process.env;
	const configuredTimeout = env.OPENCLAW_HANDSHAKE_TIMEOUT_MS || env.VITEST && env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
	if (configuredTimeout) {
		const parsed = parseStrictPositiveInteger(configuredTimeout);
		if (parsed !== void 0) return parsed;
	}
	const configured = normalizePositiveTimeoutMs(params?.configuredTimeoutMs);
	if (configured !== void 0) return configured;
	return DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
}
//#endregion
export { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS, MAX_CONNECT_CHALLENGE_TIMEOUT_MS, MIN_CONNECT_CHALLENGE_TIMEOUT_MS, clampConnectChallengeTimeoutMs, getConnectChallengeTimeoutMsFromEnv, getPreauthHandshakeTimeoutMsFromEnv, resolveConnectChallengeTimeoutMs, resolvePreauthHandshakeTimeoutMs };
