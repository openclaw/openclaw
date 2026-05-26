import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as redactToolPayloadText } from "./redact-ok5Q8nmw.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { Nn as record, Rn as string, Tn as object, Zn as unknown, dn as literal } from "./schemas-Del5uzR8.js";
import { n as privateFileStoreSync } from "./private-file-store-DMtyjgoc.js";
import { n as logError, t as logDebug } from "./logger-0o2znY2U.js";
import { i as isLoopbackHost, s as isSecureWebSocketUrl } from "./net-DCUMtgJy.js";
import { a as publicKeyRawBase64UrlFromPem, o as signDevicePayload, r as loadOrCreateDeviceIdentity } from "./device-identity-BuQ9YOu8.js";
import { t as normalizeFingerprint } from "./fingerprint-COSQ5VlL.js";
import { i as isSensitiveUrlQueryParamName } from "./redact-sensitive-url-NNYIE41N.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import "./message-channel-CYCKkVrh.js";
import { n as resolveSafeTimeoutDelayMs } from "./timer-delay-awNPCchy.js";
import { t as resolveConnectChallengeTimeoutMs } from "./handshake-timeouts-DRUWxVZ0.js";
import { n as normalizeDeviceAuthScopes, t as normalizeDeviceAuthRole } from "./device-auth-CLuEWAWX.js";
import { n as registerManagedProxyGatewayLoopbackBypass, t as ensureInheritedManagedProxyRoutingActive } from "./proxy-lifecycle-Bj6NfFMe.js";
import { t as rawDataToString } from "./ws-C3qhmaFC.js";
import { t as normalizeDeviceMetadataForAuth } from "./device-metadata-normalization-PRIe4LWk.js";
import { f as readPairingConnectErrorDetails, l as readConnectErrorDetailCode, s as formatConnectErrorMessage, t as ConnectErrorDetailCodes, u as readConnectErrorRecoveryAdvice } from "./connect-error-details-BNpp20bs.js";
import { At as validateRequestFrame, Y as validateEventFrame, jt as validateResponseFrame } from "./protocol-DiXjp30g.js";
import "./version-DDqbebEG.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket as WebSocket$1 } from "ws";
//#region src/shared/device-auth-store.ts
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function coerceDeviceAuthEntry(role, value) {
	if (!isRecord(value) || typeof value.token !== "string") return null;
	const updatedAtMs = typeof value.updatedAtMs === "number" && Number.isFinite(value.updatedAtMs) ? value.updatedAtMs : 0;
	return {
		token: value.token,
		role,
		scopes: normalizeDeviceAuthScopes(Array.isArray(value.scopes) ? value.scopes : void 0),
		updatedAtMs
	};
}
function copyCanonicalDeviceAuthTokens(tokens) {
	const out = {};
	for (const [rawRole, value] of Object.entries(tokens)) {
		const role = normalizeDeviceAuthRole(rawRole);
		if (!role) continue;
		const entry = coerceDeviceAuthEntry(role, value);
		if (entry) out[role] = entry;
	}
	return out;
}
function loadDeviceAuthTokenFromStore(params) {
	const store = params.adapter.readStore();
	if (!store || store.deviceId !== params.deviceId) return null;
	const role = normalizeDeviceAuthRole(params.role);
	return coerceDeviceAuthEntry(role, store.tokens[role]);
}
function storeDeviceAuthTokenInStore(params) {
	const role = normalizeDeviceAuthRole(params.role);
	const existing = params.adapter.readStore();
	const next = {
		version: 1,
		deviceId: params.deviceId,
		tokens: existing && existing.deviceId === params.deviceId && existing.tokens ? copyCanonicalDeviceAuthTokens(existing.tokens) : {}
	};
	const entry = {
		token: params.token,
		role,
		scopes: normalizeDeviceAuthScopes(params.scopes),
		updatedAtMs: Date.now()
	};
	next.tokens[role] = entry;
	params.adapter.writeStore(next);
	return entry;
}
function clearDeviceAuthTokenFromStore(params) {
	const store = params.adapter.readStore();
	if (!store || store.deviceId !== params.deviceId) return;
	const role = normalizeDeviceAuthRole(params.role);
	if (!store.tokens[role]) return;
	const next = {
		version: 1,
		deviceId: store.deviceId,
		tokens: copyCanonicalDeviceAuthTokens(store.tokens)
	};
	delete next.tokens[role];
	params.adapter.writeStore(next);
}
//#endregion
//#region src/infra/device-auth-store.ts
const DEVICE_AUTH_FILE = "device-auth.json";
const DeviceAuthStoreSchema = object({
	version: literal(1),
	deviceId: string(),
	tokens: record(string(), unknown())
});
function resolveDeviceAuthPath(env = process.env) {
	return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}
function readStore(filePath) {
	try {
		const parsed = privateFileStoreSync(path.dirname(filePath)).readJsonIfExists(path.basename(filePath));
		const store = DeviceAuthStoreSchema.safeParse(parsed);
		return store.success ? store.data : null;
	} catch {
		return null;
	}
}
function writeStore(filePath, store) {
	privateFileStoreSync(path.dirname(filePath)).writeJson(path.basename(filePath), store, { trailingNewline: true });
}
function loadDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	return loadDeviceAuthTokenFromStore({
		adapter: {
			readStore: () => readStore(filePath),
			writeStore: (_store) => {}
		},
		deviceId: params.deviceId,
		role: params.role
	});
}
function storeDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	return storeDeviceAuthTokenInStore({
		adapter: {
			readStore: () => readStore(filePath),
			writeStore: (store) => writeStore(filePath, store)
		},
		deviceId: params.deviceId,
		role: params.role,
		token: params.token,
		scopes: params.scopes
	});
}
function clearDeviceAuthToken(params) {
	const filePath = resolveDeviceAuthPath(params.env);
	clearDeviceAuthTokenFromStore({
		adapter: {
			readStore: () => readStore(filePath),
			writeStore: (store) => writeStore(filePath, store)
		},
		deviceId: params.deviceId,
		role: params.role
	});
}
//#endregion
//#region src/gateway/device-auth.ts
function buildDeviceAuthPayload(params) {
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	return [
		"v2",
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce
	].join("|");
}
function buildDeviceAuthPayloadV3(params) {
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	const platform = normalizeDeviceMetadataForAuth(params.platform);
	const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
	return [
		"v3",
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce,
		platform,
		deviceFamily
	].join("|");
}
//#endregion
//#region src/gateway/protocol/startup-unavailable.ts
const GATEWAY_STARTUP_UNAVAILABLE_REASON = "startup-sidecars";
const GATEWAY_STARTUP_PENDING_CLOSE_CAUSE = "startup-sidecars-pending";
const GATEWAY_STARTUP_CLOSE_CODE = 1013;
const GATEWAY_STARTUP_CLOSE_REASON = "gateway starting";
const GATEWAY_STARTUP_RETRY_MIN_MS = 100;
const GATEWAY_STARTUP_RETRY_MAX_MS = 2e3;
function gatewayStartupUnavailableDetails() {
	return { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON };
}
function isGatewayStartupUnavailableDetails(details) {
	return typeof details === "object" && details !== null && details.reason === "startup-sidecars";
}
function isRetryableGatewayStartupUnavailableError(error) {
	if (!error || typeof error !== "object") return false;
	const shaped = error;
	return (shaped.gatewayCode ?? shaped.code) === "UNAVAILABLE" && shaped.retryable === true && isGatewayStartupUnavailableDetails(shaped.details);
}
function resolveGatewayStartupRetryAfterMs(error) {
	if (!isRetryableGatewayStartupUnavailableError(error)) return null;
	const retryAfterMs = error.retryAfterMs;
	return Math.min(Math.max(Math.floor(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 500), GATEWAY_STARTUP_RETRY_MIN_MS), GATEWAY_STARTUP_RETRY_MAX_MS);
}
//#endregion
//#region src/gateway/client.ts
const DEFAULT_GATEWAY_CLIENT_URL = "ws://127.0.0.1:18789";
var GatewayClientRequestError = class extends Error {
	constructor(error) {
		super(formatConnectErrorMessage({
			message: error.message,
			details: error.details
		}));
		this.name = "GatewayClientRequestError";
		this.gatewayCode = error.code ?? "UNAVAILABLE";
		this.details = error.details;
		this.retryable = error.retryable === true;
		this.retryAfterMs = error.retryAfterMs;
	}
};
const GATEWAY_CONNECT_ASSEMBLY_ERROR = Symbol("gateway.connectAssemblyError");
function markGatewayConnectAssemblyError(error) {
	Object.defineProperty(error, GATEWAY_CONNECT_ASSEMBLY_ERROR, {
		configurable: true,
		value: true
	});
	return error;
}
function isGatewayConnectAssemblyError(value) {
	return value instanceof Error && value[GATEWAY_CONNECT_ASSEMBLY_ERROR] === true;
}
const GATEWAY_CLOSE_CODE_HINTS = {
	1e3: "normal closure",
	1006: "abnormal closure (no close frame)",
	1008: "policy violation",
	1012: "service restart",
	1013: "try again later"
};
function describeGatewayCloseCode(code) {
	return GATEWAY_CLOSE_CODE_HINTS[code];
}
function readConnectChallengeTimeoutOverride(opts) {
	if (typeof opts.connectChallengeTimeoutMs === "number" && Number.isFinite(opts.connectChallengeTimeoutMs)) return opts.connectChallengeTimeoutMs;
	if (typeof opts.connectDelayMs === "number" && Number.isFinite(opts.connectDelayMs)) return opts.connectDelayMs;
}
function isGatewayClientStoppedError(err) {
	const message = err instanceof Error ? err.message : String(err);
	return message === "gateway client stopped" || message === "Error: gateway client stopped";
}
function formatGatewayClientErrorForLog(err) {
	return redactToolPayloadText(String(err).replace(/\/\/([^@/?#\s]+)@/g, "//***:***@").replace(/([?&])([^=&\s]+)=([^&#\s"'<>)]*)/g, (match, prefix, key) => isSensitiveUrlQueryParamName(key) ? `${prefix}${key}=***` : match));
}
function resolveGatewayClientConnectChallengeTimeoutMs(opts) {
	return resolveConnectChallengeTimeoutMs(readConnectChallengeTimeoutOverride(opts), { configuredTimeoutMs: opts.preauthHandshakeTimeoutMs });
}
const FORCE_STOP_TERMINATE_GRACE_MS = 250;
const STOP_AND_WAIT_TIMEOUT_MS = 1e3;
var GatewayClient = class {
	constructor(opts) {
		this.ws = null;
		this.pending = /* @__PURE__ */ new Map();
		this.backoffMs = 1e3;
		this.closed = false;
		this.lastSeq = null;
		this.connectNonce = null;
		this.connectSent = false;
		this.connectTimer = null;
		this.reconnectTimer = null;
		this.pendingDeviceTokenRetry = false;
		this.deviceTokenRetryBudgetUsed = false;
		this.approvalRuntimeTokenCompatibilityDisabled = false;
		this.approvalRuntimeTokenRetryBudgetUsed = false;
		this.pendingStartupReconnectDelayMs = null;
		this.pendingConnectErrorDetailCode = null;
		this.pendingConnectErrorDetails = null;
		this.lastTick = null;
		this.tickIntervalMs = 3e4;
		this.tickTimer = null;
		this.pendingStop = null;
		this.socketOpened = false;
		this.opts = {
			...opts,
			deviceIdentity: opts.deviceIdentity === null ? void 0 : opts.deviceIdentity ?? loadOrCreateDeviceIdentity()
		};
		this.requestTimeoutMs = typeof opts.requestTimeoutMs === "number" && Number.isFinite(opts.requestTimeoutMs) ? resolveSafeTimeoutDelayMs(opts.requestTimeoutMs) : 3e4;
	}
	start() {
		if (this.closed) return;
		this.clearReconnectTimer();
		this.clearConnectChallengeTimeout();
		this.connectNonce = null;
		this.connectSent = false;
		const url = this.opts.url ?? DEFAULT_GATEWAY_CLIENT_URL;
		if (this.opts.tlsFingerprint && !url.startsWith("wss://")) {
			this.notifyConnectError(/* @__PURE__ */ new Error("gateway tls fingerprint requires wss:// gateway url"));
			return;
		}
		const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
		if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
			let displayHost = url;
			try {
				displayHost = new URL(url).hostname || url;
			} catch {}
			const error = /* @__PURE__ */ new Error(`SECURITY ERROR: Cannot connect to "${displayHost}" over plaintext ws://. Both credentials and chat data would be exposed to network interception. Use wss:// for remote URLs. Safe defaults: keep gateway.bind=loopback and connect via SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host), or use Tailscale Serve/Funnel. ` + (allowPrivateWs ? "" : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1. ") + "Run `openclaw doctor --fix` for guidance.");
			this.notifyConnectError(error);
			return;
		}
		ensureInheritedManagedProxyRoutingActive();
		const wsOptions = { maxPayload: 25 * 1024 * 1024 };
		if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
			wsOptions.rejectUnauthorized = false;
			wsOptions.checkServerIdentity = (_hostValue, cert) => {
				const fingerprintValue = typeof cert === "object" && cert && "fingerprint256" in cert ? cert.fingerprint256 ?? "" : "";
				const fingerprint = normalizeFingerprint(typeof fingerprintValue === "string" ? fingerprintValue : "");
				const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
				if (!expected) return;
				if (!fingerprint) return /* @__PURE__ */ new Error("Missing server TLS fingerprint");
				if (fingerprint !== expected) return /* @__PURE__ */ new Error("Server TLS fingerprint mismatch");
			};
		}
		const unregisterGatewayLoopbackBypass = registerManagedProxyGatewayLoopbackBypass(url);
		let ws;
		try {
			ws = new WebSocket$1(url, wsOptions);
		} finally {
			unregisterGatewayLoopbackBypass?.();
		}
		this.ws = ws;
		this.socketOpened = false;
		this.connectNonce = null;
		this.connectSent = false;
		this.clearConnectChallengeTimeout();
		ws.on("open", () => {
			this.socketOpened = true;
			if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
				const tlsError = this.validateTlsFingerprint();
				if (tlsError) {
					this.notifyConnectError(tlsError);
					this.ws?.close(1008, tlsError.message);
					return;
				}
			}
			this.beginPreauthHandshake();
		});
		ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
		ws.on("close", (code, reason) => {
			const reasonText = rawDataToString(reason);
			const connectErrorDetailCode = this.pendingConnectErrorDetailCode;
			const connectErrorDetails = this.pendingConnectErrorDetails;
			this.pendingConnectErrorDetailCode = null;
			this.pendingConnectErrorDetails = null;
			if (this.ws === ws) this.ws = null;
			this.socketOpened = false;
			this.resolvePendingStop(ws);
			if (this.pendingStartupReconnectDelayMs !== null) {
				this.scheduleReconnect();
				return;
			}
			if (code === 1008 && normalizeLowercaseStringOrEmpty(reasonText).includes("device token mismatch") && !this.opts.token && !this.opts.password && this.opts.deviceIdentity) {
				const deviceId = this.opts.deviceIdentity.deviceId;
				const role = this.opts.role ?? "operator";
				try {
					clearDeviceAuthToken({
						deviceId,
						role,
						env: this.opts.env
					});
					logDebug(`cleared stale device-auth token for device ${deviceId}`);
				} catch (err) {
					logDebug(`failed clearing stale device-auth token for device ${deviceId}: ${String(err)}`);
				}
			}
			this.flushPendingErrors(/* @__PURE__ */ new Error(`gateway closed (${code}): ${reasonText}`));
			if (this.shouldPauseReconnectAfterAuthFailure({
				detailCode: connectErrorDetailCode,
				details: connectErrorDetails
			})) {
				this.opts.onReconnectPaused?.({
					code,
					reason: reasonText,
					detailCode: connectErrorDetailCode
				});
				this.opts.onClose?.(code, reasonText);
				return;
			}
			this.scheduleReconnect();
			this.opts.onClose?.(code, reasonText);
		});
		ws.on("error", (err) => {
			logDebug(`gateway client error: ${formatGatewayClientErrorForLog(err)}`);
			if (!this.connectSent) this.notifyConnectError(err instanceof Error ? err : new Error(String(err)));
		});
	}
	stop() {
		this.beginStop();
	}
	async stopAndWait(opts) {
		const stopPromise = this.beginStop();
		if (!stopPromise) return;
		const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : STOP_AND_WAIT_TIMEOUT_MS;
		let timeout = null;
		try {
			await Promise.race([stopPromise, new Promise((_, reject) => {
				timeout = setTimeout(() => {
					reject(/* @__PURE__ */ new Error(`gateway client stop timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				timeout.unref?.();
			})]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	beginStop() {
		this.closed = true;
		this.pendingDeviceTokenRetry = false;
		this.deviceTokenRetryBudgetUsed = false;
		this.pendingStartupReconnectDelayMs = null;
		this.pendingConnectErrorDetailCode = null;
		this.pendingConnectErrorDetails = null;
		this.clearReconnectTimer();
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.clearConnectChallengeTimeout();
		if (this.pendingStop) {
			this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
			return this.pendingStop.promise;
		}
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			const stopPromise = this.createPendingStop(ws);
			ws.close();
			setTimeout(() => {
				try {
					ws.terminate();
				} catch {}
				this.resolvePendingStop(ws);
			}, FORCE_STOP_TERMINATE_GRACE_MS).unref?.();
			this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
			return stopPromise;
		}
		this.flushPendingErrors(/* @__PURE__ */ new Error("gateway client stopped"));
		return null;
	}
	createPendingStop(ws) {
		if (this.pendingStop?.ws === ws) return this.pendingStop.promise;
		let resolve;
		const promise = new Promise((res) => {
			resolve = res;
		});
		this.pendingStop = {
			ws,
			promise,
			resolve
		};
		return promise;
	}
	resolvePendingStop(ws) {
		if (this.pendingStop?.ws !== ws) return;
		const { resolve } = this.pendingStop;
		this.pendingStop = null;
		resolve();
	}
	sendConnect() {
		if (this.connectSent) return;
		const nonce = normalizeOptionalString(this.connectNonce) ?? "";
		if (!nonce) {
			this.notifyConnectError(/* @__PURE__ */ new Error("gateway connect challenge missing nonce"));
			this.ws?.close(1008, "connect challenge missing nonce");
			return;
		}
		const role = this.opts.role ?? "operator";
		let assembled;
		try {
			assembled = this.assembleConnectParams({
				role,
				nonce
			});
		} catch (err) {
			this.handleConnectFailure(err);
			return;
		}
		this.connectSent = true;
		this.clearConnectChallengeTimeout();
		this.request("connect", assembled.params).then((helloOk) => {
			this.pendingDeviceTokenRetry = false;
			this.deviceTokenRetryBudgetUsed = false;
			this.pendingStartupReconnectDelayMs = null;
			this.pendingConnectErrorDetailCode = null;
			this.pendingConnectErrorDetails = null;
			const authInfo = helloOk?.auth;
			if (authInfo?.deviceToken && this.opts.deviceIdentity) storeDeviceAuthToken({
				deviceId: this.opts.deviceIdentity.deviceId,
				role: authInfo.role ?? role,
				token: authInfo.deviceToken,
				scopes: authInfo.scopes ?? [],
				env: this.opts.env
			});
			this.backoffMs = 1e3;
			this.tickIntervalMs = typeof helloOk.policy?.tickIntervalMs === "number" ? helloOk.policy.tickIntervalMs : 3e4;
			this.lastTick = Date.now();
			this.startTickWatch();
			this.opts.onHelloOk?.(helloOk);
		}).catch((err) => {
			this.pendingConnectErrorDetailCode = err instanceof GatewayClientRequestError ? readConnectErrorDetailCode(err.details) : null;
			this.pendingConnectErrorDetails = err instanceof GatewayClientRequestError ? err.details : null;
			const shouldRetryWithDeviceToken = this.shouldRetryWithStoredDeviceToken({
				error: err,
				explicitGatewayToken: normalizeOptionalString(this.opts.token),
				resolvedDeviceToken: assembled.resolvedDeviceToken,
				storedToken: assembled.storedToken
			});
			if (this.opts.deviceIdentity && assembled.usingStoredDeviceToken && err instanceof GatewayClientRequestError && readConnectErrorDetailCode(err.details) === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH) {
				const deviceId = this.opts.deviceIdentity.deviceId;
				try {
					clearDeviceAuthToken({
						deviceId,
						role,
						env: this.opts.env
					});
					logDebug(`cleared stale device-auth token for device ${deviceId}`);
				} catch (clearErr) {
					logDebug(`failed clearing stale device-auth token for device ${deviceId}: ${String(clearErr)}`);
				}
			}
			if (shouldRetryWithDeviceToken) {
				this.pendingDeviceTokenRetry = true;
				this.deviceTokenRetryBudgetUsed = true;
				this.backoffMs = Math.min(this.backoffMs, 250);
			}
			const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(err);
			if (startupRetryAfterMs !== null) {
				this.pendingStartupReconnectDelayMs = startupRetryAfterMs;
				logDebug(`gateway connect failed: ${formatGatewayClientErrorForLog(err)}`);
				this.ws?.close(1013, "gateway starting");
				return;
			}
			if (this.shouldRetryWithoutApprovalRuntimeToken({
				error: err,
				authApprovalRuntimeToken: assembled.authApprovalRuntimeToken
			})) {
				this.approvalRuntimeTokenCompatibilityDisabled = true;
				this.approvalRuntimeTokenRetryBudgetUsed = true;
				this.backoffMs = Math.min(this.backoffMs, 250);
				logDebug("gateway rejected approval runtime auth field; retrying without it");
				this.ws?.close(1008, "connect retry");
				return;
			}
			this.notifyConnectError(err instanceof Error ? err : new Error(String(err)));
			const msg = `gateway connect failed: ${formatGatewayClientErrorForLog(err)}`;
			if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE || isGatewayClientStoppedError(err)) logDebug(msg);
			else logError(msg);
			this.ws?.close(1008, "connect failed");
		});
	}
	assembleConnectParams(params) {
		const { role, nonce } = params;
		const { authToken, authBootstrapToken, authDeviceToken, authPassword, authApprovalRuntimeToken, signatureToken, resolvedDeviceToken, storedToken, storedScopes, usingStoredDeviceToken } = this.selectConnectAuth(role);
		if (this.pendingDeviceTokenRetry && authDeviceToken) this.pendingDeviceTokenRetry = false;
		const auth = authToken || authBootstrapToken || authPassword || resolvedDeviceToken || authApprovalRuntimeToken ? {
			token: authToken,
			bootstrapToken: authBootstrapToken,
			deviceToken: authDeviceToken ?? resolvedDeviceToken,
			password: authPassword,
			approvalRuntimeToken: authApprovalRuntimeToken
		} : void 0;
		const signedAtMs = Date.now();
		const scopes = this.resolveConnectScopes({
			usingStoredDeviceToken,
			storedScopes
		});
		const platform = this.opts.platform ?? process.platform;
		return {
			params: {
				minProtocol: this.opts.minProtocol ?? 4,
				maxProtocol: this.opts.maxProtocol ?? 4,
				client: {
					id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
					displayName: this.opts.clientDisplayName,
					version: this.opts.clientVersion ?? VERSION,
					platform,
					deviceFamily: this.opts.deviceFamily,
					mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
					instanceId: this.opts.instanceId
				},
				caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
				commands: Array.isArray(this.opts.commands) ? this.opts.commands : void 0,
				permissions: this.opts.permissions && typeof this.opts.permissions === "object" ? this.opts.permissions : void 0,
				pathEnv: this.opts.pathEnv,
				auth,
				role,
				scopes,
				device: this.buildDeviceConnectParams({
					nonce,
					role,
					scopes,
					signatureToken,
					signedAtMs,
					platform
				})
			},
			authApprovalRuntimeToken,
			resolvedDeviceToken,
			storedToken,
			usingStoredDeviceToken
		};
	}
	buildDeviceConnectParams(params) {
		if (!this.opts.deviceIdentity) return;
		const { nonce, role, scopes, signatureToken, signedAtMs, platform } = params;
		const payload = buildDeviceAuthPayloadV3({
			deviceId: this.opts.deviceIdentity.deviceId,
			clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
			clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
			role,
			scopes,
			signedAtMs,
			token: signatureToken ?? null,
			nonce,
			platform,
			deviceFamily: this.opts.deviceFamily
		});
		const signature = signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
		return {
			id: this.opts.deviceIdentity.deviceId,
			publicKey: publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
			signature,
			signedAt: signedAtMs,
			nonce
		};
	}
	handleConnectFailure(err) {
		const error = err instanceof Error ? err : new Error(String(err));
		this.clearConnectChallengeTimeout();
		this.closed = true;
		this.notifyConnectError(markGatewayConnectAssemblyError(error));
		const msg = `gateway connect failed: ${formatGatewayClientErrorForLog(error)}`;
		if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE || isGatewayClientStoppedError(error)) logDebug(msg);
		else logError(msg);
		this.ws?.close(1008, "connect failed");
	}
	notifyConnectError(error) {
		try {
			this.opts.onConnectError?.(error);
		} catch (err) {
			logDebug(`gateway client connect error handler error: ${formatGatewayClientErrorForLog(err)}`);
		}
	}
	resolveConnectScopes(params) {
		if (Array.isArray(this.opts.scopes)) return this.opts.scopes;
		if (params.usingStoredDeviceToken && Array.isArray(params.storedScopes) && params.storedScopes.length > 0) return params.storedScopes;
		return this.opts.scopes ?? ["operator.admin"];
	}
	loadStoredDeviceAuth(role) {
		if (!this.opts.deviceIdentity) return null;
		const storedAuth = loadDeviceAuthToken({
			deviceId: this.opts.deviceIdentity.deviceId,
			role,
			env: this.opts.env
		});
		if (!storedAuth) return null;
		return {
			token: storedAuth.token,
			scopes: storedAuth.scopes
		};
	}
	shouldPauseReconnectAfterAuthFailure(params) {
		const { detailCode, details } = params;
		if (!detailCode) return false;
		const pairingDetails = readPairingConnectErrorDetails(details);
		if (detailCode === ConnectErrorDetailCodes.PAIRING_REQUIRED && (pairingDetails?.pauseReconnect === false || pairingDetails?.recommendedNextStep === "wait_then_retry")) return false;
		if (detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING || detailCode === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID || detailCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING || detailCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH || detailCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED || detailCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH || detailCode === ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH || detailCode === ConnectErrorDetailCodes.PAIRING_REQUIRED || detailCode === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED || detailCode === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED) return true;
		if (detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH) return !this.pendingDeviceTokenRetry;
		return false;
	}
	shouldRetryWithStoredDeviceToken(params) {
		if (this.deviceTokenRetryBudgetUsed) return false;
		if (params.resolvedDeviceToken) return false;
		if (!params.explicitGatewayToken || !params.storedToken) return false;
		if (!this.isTrustedDeviceRetryEndpoint()) return false;
		if (!(params.error instanceof GatewayClientRequestError)) return false;
		const detailCode = readConnectErrorDetailCode(params.error.details);
		const advice = readConnectErrorRecoveryAdvice(params.error.details);
		const retryWithDeviceTokenRecommended = advice.recommendedNextStep === "retry_with_device_token";
		return advice.canRetryWithDeviceToken === true || retryWithDeviceTokenRecommended || detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
	}
	shouldRetryWithoutApprovalRuntimeToken(params) {
		if (this.approvalRuntimeTokenRetryBudgetUsed) return false;
		if (!params.authApprovalRuntimeToken) return false;
		if (!(params.error instanceof GatewayClientRequestError)) return false;
		if (params.error.gatewayCode !== "INVALID_REQUEST") return false;
		const message = normalizeLowercaseStringOrEmpty(params.error.message);
		return message.includes("invalid connect params") && message.includes("approvalruntimetoken");
	}
	isTrustedDeviceRetryEndpoint() {
		const rawUrl = this.opts.url ?? "ws://127.0.0.1:18789";
		try {
			const parsed = new URL(rawUrl);
			const protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
			if (isLoopbackHost(parsed.hostname)) return true;
			return protocol === "wss:" && Boolean(this.opts.tlsFingerprint?.trim());
		} catch {
			return false;
		}
	}
	selectConnectAuth(role) {
		const explicitGatewayToken = normalizeOptionalString(this.opts.token);
		const explicitBootstrapToken = normalizeOptionalString(this.opts.bootstrapToken);
		const explicitDeviceToken = normalizeOptionalString(this.opts.deviceToken);
		const authPassword = normalizeOptionalString(this.opts.password);
		const authApprovalRuntimeToken = this.approvalRuntimeTokenCompatibilityDisabled ? void 0 : normalizeOptionalString(this.opts.approvalRuntimeToken);
		const storedAuth = this.loadStoredDeviceAuth(role);
		const storedToken = storedAuth?.token ?? null;
		const storedScopes = storedAuth?.scopes;
		const shouldUseDeviceRetryToken = this.pendingDeviceTokenRetry && !explicitDeviceToken && Boolean(explicitGatewayToken) && Boolean(storedToken) && this.isTrustedDeviceRetryEndpoint();
		const resolvedDeviceToken = explicitDeviceToken ?? (shouldUseDeviceRetryToken || !(explicitGatewayToken || authPassword) && (!explicitBootstrapToken || Boolean(storedToken)) ? storedToken ?? void 0 : void 0);
		const reusingStoredDeviceToken = Boolean(resolvedDeviceToken) && !explicitDeviceToken && Boolean(storedToken) && resolvedDeviceToken === storedToken;
		const authToken = explicitGatewayToken ?? resolvedDeviceToken;
		const authBootstrapToken = !explicitGatewayToken && !resolvedDeviceToken && !authPassword ? explicitBootstrapToken : void 0;
		return {
			authToken,
			authBootstrapToken,
			authDeviceToken: shouldUseDeviceRetryToken ? storedToken ?? void 0 : void 0,
			authPassword,
			authApprovalRuntimeToken,
			signatureToken: authToken ?? authBootstrapToken ?? void 0,
			resolvedDeviceToken,
			storedToken: storedToken ?? void 0,
			storedScopes,
			usingStoredDeviceToken: reusingStoredDeviceToken
		};
	}
	handleMessage(raw) {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			logDebug(`gateway client parse error: ${formatGatewayClientErrorForLog(err)}`);
			return;
		}
		if (validateEventFrame(parsed)) {
			this.lastTick = Date.now();
			const evt = parsed;
			if (evt.event === "connect.challenge") {
				const payload = evt.payload;
				const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
				if (!nonce || nonce.trim().length === 0) {
					this.notifyConnectError(/* @__PURE__ */ new Error("gateway connect challenge missing nonce"));
					this.ws?.close(1008, "connect challenge missing nonce");
					return;
				}
				this.connectNonce = nonce.trim();
				if (this.socketOpened) this.sendConnect();
				return;
			}
			try {
				const seq = typeof evt.seq === "number" ? evt.seq : null;
				if (seq !== null) {
					if (this.lastSeq !== null && seq > this.lastSeq + 1) this.opts.onGap?.({
						expected: this.lastSeq + 1,
						received: seq
					});
					this.lastSeq = seq;
				}
				if (evt.event === "tick") this.lastTick = Date.now();
				this.opts.onEvent?.(evt);
			} catch (err) {
				logDebug(`gateway client event handler error: ${formatGatewayClientErrorForLog(err)}`);
			}
			return;
		}
		if (validateResponseFrame(parsed)) {
			this.lastTick = Date.now();
			const pending = this.pending.get(parsed.id);
			if (!pending) return;
			const status = parsed.payload?.status;
			if (pending.expectFinal && status === "accepted") {
				if (!pending.acceptedNotified) {
					pending.acceptedNotified = true;
					try {
						pending.onAccepted?.(parsed.payload);
					} catch (err) {
						logDebug(`gateway client accepted callback error: ${formatGatewayClientErrorForLog(err)}`);
					}
				}
				return;
			}
			this.pending.delete(parsed.id);
			pending.cleanup?.();
			if (parsed.ok) pending.resolve(parsed.payload);
			else pending.reject(new GatewayClientRequestError({
				code: parsed.error?.code,
				message: parsed.error?.message ?? "unknown error",
				details: parsed.error?.details,
				retryable: parsed.error?.retryable,
				retryAfterMs: parsed.error?.retryAfterMs
			}));
		}
	}
	beginPreauthHandshake() {
		if (this.connectSent) return;
		if (this.connectNonce && !this.connectSent) {
			this.armConnectChallengeTimeout();
			this.sendConnect();
			return;
		}
		this.armConnectChallengeTimeout();
	}
	clearConnectChallengeTimeout() {
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
	}
	clearReconnectTimer() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
	armConnectChallengeTimeout() {
		const connectChallengeTimeoutMs = resolveGatewayClientConnectChallengeTimeoutMs(this.opts);
		const armedAt = Date.now();
		this.clearConnectChallengeTimeout();
		this.connectTimer = setTimeout(() => {
			if (this.connectSent || this.ws?.readyState !== WebSocket$1.OPEN) return;
			const elapsedMs = Date.now() - armedAt;
			this.notifyConnectError(/* @__PURE__ */ new Error(`gateway connect challenge timeout (waited ${elapsedMs}ms, limit ${connectChallengeTimeoutMs}ms)`));
			this.ws?.close(1008, "connect challenge timeout");
		}, connectChallengeTimeoutMs);
	}
	scheduleReconnect() {
		if (this.closed) return;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.clearReconnectTimer();
		const startupDelay = this.pendingStartupReconnectDelayMs;
		this.pendingStartupReconnectDelayMs = null;
		const delay = startupDelay ?? this.backoffMs;
		if (startupDelay === null) this.backoffMs = Math.min(this.backoffMs * 2, 3e4);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.start();
		}, delay);
	}
	flushPendingErrors(err) {
		for (const [, p] of this.pending) {
			p.cleanup?.();
			p.reject(err);
		}
		this.pending.clear();
	}
	startTickWatch() {
		if (this.tickTimer) clearInterval(this.tickTimer);
		const rawMinInterval = this.opts.tickWatchMinIntervalMs;
		const minInterval = typeof rawMinInterval === "number" && Number.isFinite(rawMinInterval) ? Math.max(1, Math.min(3e4, rawMinInterval)) : 1e3;
		const interval = Math.max(this.tickIntervalMs, minInterval);
		this.tickTimer = setInterval(() => {
			if (this.closed) return;
			if (!this.lastTick) return;
			if (this.pending.size > 0) return;
			if (Date.now() - this.lastTick > this.tickIntervalMs * 2) this.ws?.close(4e3, "tick timeout");
		}, interval);
	}
	validateTlsFingerprint() {
		if (!this.opts.tlsFingerprint || !this.ws) return null;
		const expected = normalizeFingerprint(this.opts.tlsFingerprint);
		if (!expected) return /* @__PURE__ */ new Error("gateway tls fingerprint missing");
		const socket = this.ws["_socket"];
		if (!socket || typeof socket.getPeerCertificate !== "function") return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		const fingerprint = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256 ?? "");
		if (!fingerprint) return /* @__PURE__ */ new Error("gateway tls fingerprint unavailable");
		if (fingerprint !== expected) return /* @__PURE__ */ new Error("gateway tls fingerprint mismatch");
		return null;
	}
	async request(method, params, opts) {
		if (!this.ws || this.ws.readyState !== WebSocket$1.OPEN) throw new Error("gateway not connected");
		if (opts?.signal?.aborted) throw createGatewayRequestAbortError(method);
		const id = randomUUID();
		const frame = {
			type: "req",
			id,
			method,
			params
		};
		if (!validateRequestFrame(frame)) throw new Error(`invalid request frame: ${JSON.stringify(validateRequestFrame.errors, null, 2)}`);
		const expectFinal = opts?.expectFinal === true;
		const timeoutMs = opts?.timeoutMs === null ? null : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? resolveSafeTimeoutDelayMs(opts.timeoutMs) : expectFinal ? null : this.requestTimeoutMs;
		const signal = opts?.signal;
		const p = new Promise((resolve, reject) => {
			let abortHandler;
			const timeout = timeoutMs === null ? null : setTimeout(() => {
				const pending = this.pending.get(id);
				this.pending.delete(id);
				pending?.cleanup?.();
				reject(/* @__PURE__ */ new Error(`gateway request timeout for ${method}`));
			}, timeoutMs);
			const cleanup = () => {
				if (timeout) clearTimeout(timeout);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			};
			abortHandler = () => {
				const pending = this.pending.get(id);
				this.pending.delete(id);
				pending?.cleanup?.();
				reject(createGatewayRequestAbortError(method));
			};
			this.pending.set(id, {
				resolve: (value) => resolve(value),
				reject,
				expectFinal,
				timeout,
				cleanup,
				onAccepted: opts?.onAccepted
			});
			signal?.addEventListener("abort", abortHandler, { once: true });
		});
		this.ws.send(JSON.stringify(frame));
		return p;
	}
};
function createGatewayRequestAbortError(method) {
	const err = /* @__PURE__ */ new Error(`gateway request aborted for ${method}`);
	err.name = "AbortError";
	return err;
}
//#endregion
export { isGatewayConnectAssemblyError as a, GATEWAY_STARTUP_CLOSE_REASON as c, buildDeviceAuthPayload as d, buildDeviceAuthPayloadV3 as f, describeGatewayCloseCode as i, GATEWAY_STARTUP_PENDING_CLOSE_CAUSE as l, GatewayClient as n, resolveGatewayClientConnectChallengeTimeoutMs as o, loadDeviceAuthToken as p, GatewayClientRequestError as r, GATEWAY_STARTUP_CLOSE_CODE as s, GATEWAY_CLOSE_CODE_HINTS as t, gatewayStartupUnavailableDetails as u };
