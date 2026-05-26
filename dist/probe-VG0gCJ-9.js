import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { n as resolveSafeTimeoutDelayMs, t as MAX_SAFE_TIMEOUT_DELAY_MS } from "./timer-delay-awNPCchy.js";
import { t as startGatewayClientWhenEventLoopReady } from "./client-start-readiness-zY0I9Wur.js";
import { n as GatewayClient, p as loadDeviceAuthToken, r as GatewayClientRequestError } from "./client-B1EH_7Mz.js";
import { i as READ_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
//#region src/gateway/probe.ts
const MIN_PROBE_TIMEOUT_MS = 250;
const MAX_TIMER_DELAY_MS = MAX_SAFE_TIMEOUT_DELAY_MS;
const PAIRING_REQUIRED_PATTERN = /\bpairing required\b/i;
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
function clampProbeTimeoutMs(timeoutMs) {
	return resolveSafeTimeoutDelayMs(timeoutMs, { minMs: 250 });
}
function formatProbeCloseError(close) {
	return `gateway closed (${close.code}): ${close.reason}`;
}
function emptyProbeAuth() {
	return {
		role: null,
		scopes: [],
		capability: "unknown"
	};
}
function emptyProbeServer() {
	return {
		version: null,
		connId: null
	};
}
function resolveProbeAuthSummary(params) {
	const scopes = Array.isArray(params.scopes) ? params.scopes : [];
	return {
		role: params.role ?? null,
		scopes,
		capability: resolveGatewayProbeCapability({
			auth: { scopes },
			authMetadataPresent: params.authMetadataPresent,
			error: params.error,
			close: params.close,
			verifiedRead: params.verifiedRead,
			connectLatencyMs: params.connectLatencyMs
		})
	};
}
function isPairingPendingProbeFailure(params) {
	return PAIRING_REQUIRED_PATTERN.test(params.close?.reason ?? params.error ?? "");
}
function resolveGatewayProbeCapability(params) {
	if (isPairingPendingProbeFailure(params)) return "pairing_pending";
	const scopes = Array.isArray(params.auth?.scopes) ? params.auth.scopes : [];
	if (scopes.includes(OPERATOR_ADMIN_SCOPE)) return "admin_capable";
	if (scopes.includes(OPERATOR_WRITE_SCOPE)) return "write_capable";
	if (scopes.includes(OPERATOR_READ_SCOPE) || params.verifiedRead === true) return "read_only";
	if (params.connectLatencyMs != null && params.authMetadataPresent === true) return "connected_no_operator_scope";
	return "unknown";
}
async function probeGateway(opts) {
	const startedAt = Date.now();
	const instanceId = randomUUID();
	let connectLatencyMs = null;
	let connectError = null;
	let connectErrorDetails = null;
	let close = null;
	let auth = emptyProbeAuth();
	let server = emptyProbeServer();
	let authMetadataPresent = false;
	const detailLevel = opts.includeDetails === false ? "none" : opts.detailLevel ?? "full";
	const deviceIdentity = await (async () => {
		try {
			if (!URL.canParse(opts.url)) return null;
			const { loadDeviceIdentityIfPresent } = await import("./device-identity-BSJCsCqO.js");
			const stateDir = resolveStateDir(opts.env);
			const identity = loadDeviceIdentityIfPresent(path.join(stateDir, "identity", "device.json"));
			if (!identity) return null;
			return loadDeviceAuthToken({
				deviceId: identity.deviceId,
				role: "operator",
				env: opts.env
			}) ? identity : null;
		} catch {
			return null;
		}
	})();
	const initialProbeTimeoutMs = clampProbeTimeoutMs(opts.timeoutMs);
	return await new Promise((resolve) => {
		let settled = false;
		let timer = null;
		const startAbort = new AbortController();
		const clearProbeTimer = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};
		const armProbeTimer = (onTimeout, timeoutMs = initialProbeTimeoutMs) => {
			clearProbeTimer();
			timer = setTimeout(onTimeout, resolveSafeTimeoutDelayMs(timeoutMs));
		};
		const settle = (result) => {
			if (settled) return;
			settled = true;
			startAbort.abort();
			clearProbeTimer();
			client.stop();
			const { connectErrorDetails: resultConnectErrorDetails, ...rest } = result;
			resolve({
				url: opts.url,
				...rest,
				...resultConnectErrorDetails != null ? { connectErrorDetails: resultConnectErrorDetails } : {}
			});
		};
		const settleProbe = (params) => {
			settle({
				ok: params.ok,
				connectLatencyMs,
				error: params.error,
				connectErrorDetails,
				close,
				auth: resolveProbeAuthSummary({
					role: auth.role,
					scopes: auth.scopes,
					authMetadataPresent,
					error: params.error,
					close,
					verifiedRead: params.verifiedRead,
					connectLatencyMs
				}),
				server,
				health: params.health,
				status: params.status,
				presence: params.presence,
				configSnapshot: params.configSnapshot
			});
		};
		const client = new GatewayClient({
			url: opts.url,
			token: opts.auth?.token,
			password: opts.auth?.password,
			tlsFingerprint: opts.tlsFingerprint,
			preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs,
			env: opts.env,
			scopes: [READ_SCOPE],
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			clientVersion: "dev",
			mode: GATEWAY_CLIENT_MODES.PROBE,
			instanceId,
			deviceIdentity,
			onConnectError: (err) => {
				connectError = formatErrorMessage(err);
				connectErrorDetails = err instanceof GatewayClientRequestError ? err.details : null;
			},
			onClose: (code, reason) => {
				close = {
					code,
					reason
				};
				if (connectLatencyMs == null) settleProbe({
					ok: false,
					error: connectError || formatProbeCloseError(close),
					health: null,
					status: null,
					presence: null,
					configSnapshot: null
				});
			},
			onHelloOk: async (hello) => {
				connectLatencyMs = Date.now() - startedAt;
				authMetadataPresent = typeof hello?.auth === "object" && hello.auth !== null;
				server = {
					version: typeof hello?.server?.version === "string" ? hello.server.version : null,
					connId: typeof hello?.server?.connId === "string" ? hello.server.connId : null
				};
				auth = resolveProbeAuthSummary({
					role: typeof hello?.auth?.role === "string" ? hello.auth.role : null,
					scopes: Array.isArray(hello?.auth?.scopes) ? hello.auth.scopes.filter((scope) => typeof scope === "string") : [],
					authMetadataPresent
				});
				if (detailLevel === "none") {
					settleProbe({
						ok: true,
						error: null,
						verifiedRead: false,
						health: null,
						status: null,
						presence: null,
						configSnapshot: null
					});
					return;
				}
				armProbeTimer(() => {
					settleProbe({
						ok: false,
						error: "timeout",
						health: null,
						status: null,
						presence: null,
						configSnapshot: null
					});
				});
				try {
					if (detailLevel === "presence") {
						const presence = await client.request("system-presence");
						settleProbe({
							ok: true,
							error: null,
							verifiedRead: true,
							health: null,
							status: null,
							presence: Array.isArray(presence) ? presence : null,
							configSnapshot: null
						});
						return;
					}
					const [health, status, presence, configSnapshot] = await Promise.all([
						client.request("health"),
						client.request("status"),
						client.request("system-presence"),
						client.request("config.get", {})
					]);
					settleProbe({
						ok: true,
						error: null,
						verifiedRead: true,
						health,
						status,
						presence: Array.isArray(presence) ? presence : null,
						configSnapshot
					});
				} catch (err) {
					settleProbe({
						ok: false,
						error: formatErrorMessage(err),
						health: null,
						status: null,
						presence: null,
						configSnapshot: null
					});
				}
			}
		});
		armProbeTimer(() => {
			settleProbe({
				ok: false,
				error: connectError ? `connect failed: ${connectError}` : "timeout",
				health: null,
				status: null,
				presence: null,
				configSnapshot: null
			});
		});
		startGatewayClientWhenEventLoopReady(client, {
			timeoutMs: initialProbeTimeoutMs,
			signal: startAbort.signal
		}).then((readiness) => {
			if (settled || readiness.ready || readiness.aborted) return;
			settleProbe({
				ok: false,
				error: "timeout",
				health: null,
				status: null,
				presence: null,
				configSnapshot: null
			});
		}).catch((err) => {
			if (settled) return;
			connectError = formatErrorMessage(err);
			settleProbe({
				ok: false,
				error: connectError,
				health: null,
				status: null,
				presence: null,
				configSnapshot: null
			});
		});
	});
}
//#endregion
export { probeGateway as a, isPairingPendingProbeFailure as i, MIN_PROBE_TIMEOUT_MS as n, resolveGatewayProbeCapability as o, clampProbeTimeoutMs as r, MAX_TIMER_DELAY_MS as t };
