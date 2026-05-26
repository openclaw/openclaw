import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { s as resolveRuntimeServiceVersion } from "./version-CQfgAE7_.js";
import { t as normalizeArrayBackedTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import { S as runWithDiagnosticTraceContext, p as createDiagnosticTraceContext } from "./diagnostic-events-BLgzARSp.js";
import { a as isPrivateOrLoopbackAddress, c as isTrustedProxyAddress, f as resolveClientIp, h as resolveHostName, i as isLoopbackHost, n as isLocalishHost, o as isPrivateOrLoopbackHost, r as isLoopbackAddress } from "./net-DCUMtgJy.js";
import { i as AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET, n as AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN } from "./auth-rate-limit-DA3xJNFz.js";
import { a as hasForwardedRequestHeaders, i as authorizeWsControlUiGatewayConnect, o as isLocalDirectRequest, r as authorizeHttpGatewayConnect, s as checkBrowserOrigin } from "./auth-DZ1o6pTQ.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { i as normalizeDevicePublicKeyBase64Url, s as verifyDeviceSignature, t as deriveDeviceIdFromPublicKey } from "./device-identity-BuQ9YOu8.js";
import { n as GATEWAY_CLIENT_IDS, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { a as isOperatorUiClient, n as isGatewayCliClient, o as isWebchatClient, t as isBrowserOperatorUiClient } from "./message-channel-CYCKkVrh.js";
import { c as GATEWAY_STARTUP_CLOSE_REASON, d as buildDeviceAuthPayload, f as buildDeviceAuthPayloadV3, l as GATEWAY_STARTUP_PENDING_CLOSE_CAUSE, s as GATEWAY_STARTUP_CLOSE_CODE, u as gatewayStartupUnavailableDetails } from "./client-B1EH_7Mz.js";
import { t as rawDataToString } from "./ws-C3qhmaFC.js";
import { t as normalizeDeviceMetadataForAuth } from "./device-metadata-normalization-PRIe4LWk.js";
import { i as buildPairingConnectErrorMessage, m as resolveDeviceAuthConnectErrorDetailCode, n as buildPairingConnectCloseReason, p as resolveAuthConnectErrorDetailCode, r as buildPairingConnectErrorDetails, t as ConnectErrorDetailCodes } from "./connect-error-details-BNpp20bs.js";
import { At as validateRequestFrame, M as validateConnectParams, Ni as ErrorCodes, Pi as errorShape, t as formatValidationErrors } from "./protocol-DiXjp30g.js";
import "./version-DDqbebEG.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import { n as isOperatorApprovalRuntimeToken } from "./operator-approval-runtime-token-C5pv_wEb.js";
import { n as logRejectedLargePayload } from "./diagnostic-payload-DTCZLTc7.js";
import { a as MAX_PAYLOAD_BYTES, i as MAX_BUFFERED_BYTES, o as MAX_PREAUTH_PAYLOAD_BYTES, s as TICK_INTERVAL_MS } from "./server-constants-BGwLM6XN.js";
import { a as indexPluginNodeCapabilitySurfaces, l as resolvePluginNodeCapabilityTtlMs, o as mintPluginNodeCapabilityToken, r as buildPluginNodeCapabilityScopedHostUrl, u as setClientPluginNodeCapability } from "./plugin-node-capability-C7GppvZZ.js";
import { a as normalizeDeclaredNodeCommands, o as resolveNodeCommandAllowlist, s as resolveNodePairingCommandAllowlist } from "./node-command-policy-Bsyvfkrl.js";
import { n as logWs, t as formatForLog } from "./ws-log-Ds39xp21.js";
import { l as roleScopesAllow } from "./pairing-token-CX9_g8Xs.js";
import { c as updatePairedNodeMetadata, n as getPairedNode, s as requestNodePairing } from "./node-pairing-Dqxd4uL_.js";
import { i as recordRemoteNodeInfo, o as refreshRemoteNodeBins } from "./skills-remote-BCbpja7h.js";
import { a as redeemDeviceBootstrapTokenProfile, d as PAIRING_SETUP_BOOTSTRAP_PROFILE, l as verifyDeviceBootstrapToken, n as getBoundDeviceBootstrapProfile, o as restoreDeviceBootstrapToken, p as resolveBootstrapProfileScopesForRole, r as getDeviceBootstrapTokenProfile, s as revokeDeviceBootstrapToken, u as BOOTSTRAP_HANDOFF_OPERATOR_SCOPES } from "./device-bootstrap-Db5YGvK1.js";
import { _ as updatePairedDeviceMetadata, a as getPairedDevice, c as listApprovedPairedDeviceRoles, l as listDevicePairing, n as approveDevicePairing, p as requestDevicePairing, r as ensureDeviceToken, s as hasEffectivePairedDeviceRole, t as approveBootstrapDevicePairing, u as listEffectivePairedDeviceRoles, v as verifyDeviceToken } from "./device-pairing-C3feAqgm.js";
import { r as loadVoiceWakeConfig, t as formatError } from "./server-utils-9y0vZuz2.js";
import { r as upsertPresence } from "./system-presence-Cj1j_O4u.js";
import { a as incrementPresenceVersion, n as getHealthCache, r as getHealthVersion, t as buildGatewaySnapshot } from "./health-state-DDBJpyWb.js";
import { c as roleCanSkipDeviceIdentity, s as parseGatewayRole, t as loadVoiceWakeRoutingConfig } from "./voicewake-routing-DJqnkQlz.js";
import { t as resolveSharedGatewaySessionGeneration } from "./ws-shared-generation-Bp5l7wzu.js";
import { t as truncateCloseReason } from "./close-reason-f7R6T5LC.js";
import os from "node:os";
//#region src/gateway/node-connect-reconcile.ts
function resolveApprovedReconnectCommands(params) {
	return normalizeDeclaredNodeCommands({
		declaredCommands: Array.isArray(params.pairedCommands) ? params.pairedCommands : [],
		allowlist: params.allowlist
	});
}
function normalizeApprovalSurfaceList(value) {
	return normalizeArrayBackedTrimmedStringList(value) ?? [];
}
function sameApprovalSurfaceSet(left, right) {
	const normalizedLeft = new Set(normalizeApprovalSurfaceList(left));
	const normalizedRight = new Set(normalizeApprovalSurfaceList(right));
	if (normalizedLeft.size !== normalizedRight.size) return false;
	for (const entry of normalizedLeft) if (!normalizedRight.has(entry)) return false;
	return true;
}
function normalizePermissionMap(value) {
	if (!value) return;
	const entries = Object.entries(value).toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	return entries.length > 0 ? Object.fromEntries(entries) : void 0;
}
function samePermissions(left, right) {
	const leftEntries = Object.entries(left ?? {}).toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	const rightEntries = Object.entries(right ?? {}).toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	if (leftEntries.length !== rightEntries.length) return false;
	return leftEntries.every(([key, value], index) => {
		const rightEntry = rightEntries[index];
		return rightEntry !== void 0 && rightEntry[0] === key && rightEntry[1] === value;
	});
}
function intersectApprovalSurfaceList(params) {
	const approved = new Set(normalizeApprovalSurfaceList(params.approved));
	return normalizeApprovalSurfaceList(params.declared).filter((entry) => approved.has(entry));
}
function intersectPermissionSurface(params) {
	const entries = [];
	for (const [key, declaredValue] of Object.entries(params.declared ?? {})) {
		const approvedValue = params.approved?.[key];
		if (!declaredValue) {
			entries.push([key, false]);
			continue;
		}
		if (approvedValue === true) {
			entries.push([key, true]);
			continue;
		}
		if (approvedValue === false) entries.push([key, false]);
	}
	return entries.length > 0 ? Object.fromEntries(entries) : void 0;
}
function buildNodePairingRequestInput(params) {
	return {
		nodeId: params.nodeId,
		displayName: params.connectParams.client.displayName,
		platform: params.connectParams.client.platform,
		version: params.connectParams.client.version,
		deviceFamily: params.connectParams.client.deviceFamily,
		modelIdentifier: params.connectParams.client.modelIdentifier,
		caps: params.caps,
		commands: params.commands,
		permissions: params.permissions,
		remoteIp: params.remoteIp
	};
}
async function reconcileNodePairingOnConnect(params) {
	const nodeId = params.connectParams.device?.id ?? params.connectParams.client.id;
	const policyNode = {
		platform: params.connectParams.client.platform,
		deviceFamily: params.connectParams.client.deviceFamily,
		caps: params.connectParams.caps,
		commands: params.connectParams.commands
	};
	const pairingAllowlist = resolveNodePairingCommandAllowlist(params.cfg, policyNode);
	const declared = normalizeDeclaredNodeCommands({
		declaredCommands: Array.isArray(params.connectParams.commands) ? params.connectParams.commands : [],
		allowlist: pairingAllowlist
	});
	const declaredCaps = normalizeApprovalSurfaceList(params.connectParams.caps);
	const declaredPermissions = normalizePermissionMap(params.connectParams.permissions);
	if (!params.pairedNode) return {
		nodeId,
		declaredCaps,
		effectiveCaps: [],
		declaredCommands: declared,
		effectiveCommands: [],
		declaredPermissions,
		effectivePermissions: void 0,
		pendingPairing: await params.requestPairing(buildNodePairingRequestInput({
			nodeId,
			connectParams: params.connectParams,
			caps: declaredCaps,
			commands: declared,
			permissions: declaredPermissions,
			remoteIp: params.reportedClientIp
		}))
	};
	const runtimeAllowlist = resolveNodeCommandAllowlist(params.cfg, {
		...policyNode,
		approvedCommands: params.pairedNode.commands
	});
	const approvedCommands = resolveApprovedReconnectCommands({
		pairedCommands: params.pairedNode.commands,
		allowlist: runtimeAllowlist
	});
	const approvedCaps = normalizeApprovalSurfaceList(params.pairedNode.caps);
	const approvedPermissions = normalizePermissionMap(params.pairedNode.permissions);
	const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));
	const hasCapabilityChange = !sameApprovalSurfaceSet(params.pairedNode.caps, declaredCaps);
	const hasPermissionChange = !samePermissions(params.pairedNode.permissions, declaredPermissions);
	const effectiveApprovedDeclaredCaps = intersectApprovalSurfaceList({
		approved: approvedCaps,
		declared: declaredCaps
	});
	const effectiveApprovedDeclaredCommands = intersectApprovalSurfaceList({
		approved: approvedCommands,
		declared
	});
	const effectiveApprovedDeclaredPermissions = intersectPermissionSurface({
		approved: approvedPermissions,
		declared: declaredPermissions
	});
	if (hasCommandUpgrade || hasCapabilityChange || hasPermissionChange) return {
		nodeId,
		declaredCaps,
		effectiveCaps: effectiveApprovedDeclaredCaps,
		declaredCommands: declared,
		effectiveCommands: effectiveApprovedDeclaredCommands,
		declaredPermissions,
		effectivePermissions: effectiveApprovedDeclaredPermissions,
		pendingPairing: await params.requestPairing(buildNodePairingRequestInput({
			nodeId,
			connectParams: params.connectParams,
			caps: declaredCaps,
			commands: declared,
			permissions: declaredPermissions ?? (hasPermissionChange ? {} : void 0),
			remoteIp: params.reportedClientIp
		}))
	};
	return {
		nodeId,
		declaredCaps,
		effectiveCaps: declaredCaps,
		declaredCommands: declared,
		effectiveCommands: declared,
		declaredPermissions,
		effectivePermissions: declaredPermissions
	};
}
//#endregion
//#region src/gateway/node-pairing-auto-approve.ts
function resolveNodePairingClientIpSource(params) {
	if (!params.reportedClientIp) return "none";
	if (!params.hasProxyHeaders || !params.remoteIsTrustedProxy) return "direct";
	return params.remoteIsLoopback ? "loopback-trusted-proxy" : "trusted-proxy";
}
function shouldAutoApproveNodePairingFromTrustedCidrs(params) {
	if (params.existingPairedDevice) return false;
	if (params.role !== "node") return false;
	if (params.reason !== "not-paired") return false;
	if (params.scopes.length > 0) return false;
	if (params.hasBrowserOriginHeader || params.isControlUi || params.isWebchat) return false;
	if (params.reportedClientIpSource === "none" || params.reportedClientIpSource === "loopback-trusted-proxy") return false;
	if (!params.reportedClientIp) return false;
	const autoApproveCidrs = params.autoApproveCidrs?.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	if (!autoApproveCidrs || autoApproveCidrs.length === 0) return false;
	return isTrustedProxyAddress(params.reportedClientIp, autoApproveCidrs);
}
//#endregion
//#region src/gateway/server/ws-connection/auth-context.ts
function mapDeviceTokenAuthFailureReason(params) {
	if (params.tokenCheckReason === "scope-mismatch" || params.tokenCheckReason === "scope_mismatch") return "scope_mismatch";
	if (params.candidateSource === "explicit-device-token") return "device_token_mismatch";
	return params.fallbackReason ?? "device_token_mismatch";
}
function resolveSharedConnectAuth(connectAuth) {
	const token = normalizeOptionalString(connectAuth?.token);
	const password = normalizeOptionalString(connectAuth?.password);
	if (!token && !password) return;
	return {
		token,
		password
	};
}
function resolveDeviceTokenCandidate(connectAuth) {
	const explicitDeviceToken = normalizeOptionalString(connectAuth?.deviceToken);
	if (explicitDeviceToken) return {
		token: explicitDeviceToken,
		source: "explicit-device-token"
	};
	const fallbackToken = normalizeOptionalString(connectAuth?.token);
	if (!fallbackToken) return {};
	return {
		token: fallbackToken,
		source: "shared-token-fallback"
	};
}
async function resolveConnectAuthState(params) {
	const sharedConnectAuth = resolveSharedConnectAuth(params.connectAuth);
	const sharedAuthProvided = Boolean(sharedConnectAuth);
	const bootstrapTokenCandidate = params.hasDeviceIdentity ? normalizeOptionalString(params.connectAuth?.bootstrapToken) : void 0;
	const { token: deviceTokenCandidate, source: deviceTokenCandidateSource } = params.hasDeviceIdentity ? resolveDeviceTokenCandidate(params.connectAuth) : {};
	let authResult = await authorizeWsControlUiGatewayConnect({
		auth: params.resolvedAuth,
		connectAuth: sharedConnectAuth,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback,
		rateLimiter: sharedAuthProvided ? params.rateLimiter : void 0,
		clientIp: params.clientIp,
		rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET
	});
	const sharedAuthResult = sharedConnectAuth && await authorizeHttpGatewayConnect({
		auth: {
			...params.resolvedAuth,
			allowTailscale: false
		},
		connectAuth: sharedConnectAuth,
		req: params.req,
		trustedProxies: params.trustedProxies,
		allowRealIpFallback: params.allowRealIpFallback,
		rateLimitScope: "shared-secret"
	});
	const sharedAuthOk = sharedAuthResult?.ok === true && (sharedAuthResult.method === "token" || sharedAuthResult.method === "password") || authResult.ok && authResult.method === "trusted-proxy";
	return {
		authResult,
		authOk: authResult.ok,
		authMethod: authResult.method ?? (params.resolvedAuth.mode === "password" ? "password" : "token"),
		sharedAuthOk,
		sharedAuthProvided,
		bootstrapTokenCandidate,
		deviceTokenCandidate,
		deviceTokenCandidateSource
	};
}
async function resolveConnectAuthDecision(params) {
	let authResult = params.state.authResult;
	let authOk = params.state.authOk;
	let authMethod = params.state.authMethod;
	const bootstrapTokenCandidate = params.state.bootstrapTokenCandidate;
	if (params.hasDeviceIdentity && params.deviceId && params.publicKey && bootstrapTokenCandidate) {
		const tokenCheck = await params.verifyBootstrapToken({
			deviceId: params.deviceId,
			publicKey: params.publicKey,
			token: bootstrapTokenCandidate,
			role: params.role,
			scopes: params.scopes
		});
		if (tokenCheck.ok) {
			authOk = true;
			authMethod = "bootstrap-token";
		} else if (!authOk) authResult = {
			ok: false,
			reason: tokenCheck.reason ?? "bootstrap_token_invalid"
		};
	}
	const deviceTokenCandidate = params.state.deviceTokenCandidate;
	if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) return {
		authResult,
		authOk,
		authMethod
	};
	let deviceTokenRateLimited = false;
	if (params.rateLimiter) {
		const deviceRateCheck = params.rateLimiter.check(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
		if (!deviceRateCheck.allowed) {
			deviceTokenRateLimited = true;
			authResult = {
				ok: false,
				reason: "rate_limited",
				rateLimited: true,
				retryAfterMs: deviceRateCheck.retryAfterMs
			};
		}
	}
	if (!deviceTokenRateLimited) {
		const tokenCheck = await params.verifyDeviceToken({
			deviceId: params.deviceId,
			token: deviceTokenCandidate,
			role: params.role,
			scopes: params.scopes
		});
		if (tokenCheck.ok) {
			authOk = true;
			authMethod = "device-token";
			params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
			if (params.state.sharedAuthProvided) params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
		} else {
			authResult = {
				ok: false,
				reason: mapDeviceTokenAuthFailureReason({
					tokenCheckReason: tokenCheck.reason,
					candidateSource: params.state.deviceTokenCandidateSource,
					fallbackReason: authResult.reason
				})
			};
			params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
		}
	}
	return {
		authResult,
		authOk,
		authMethod
	};
}
//#endregion
//#region src/gateway/server/ws-connection/auth-messages.ts
function formatGatewayAuthFailureMessage(params) {
	const { authMode, authProvided, reason, client } = params;
	const isCli = isGatewayCliClient(client);
	const isControlUi = isOperatorUiClient(client);
	const isWebchat = isWebchatClient(client);
	const tokenHint = isCli ? "set gateway.remote.token to match gateway.auth.token" : isControlUi || isWebchat ? "open the dashboard URL and paste the token in Control UI settings" : "provide gateway auth token";
	const passwordHint = isCli ? "set gateway.remote.password to match gateway.auth.password" : isControlUi || isWebchat ? "enter the password in Control UI settings" : "provide gateway auth password";
	switch (reason) {
		case "token_missing": return `unauthorized: gateway token missing (${tokenHint})`;
		case "token_mismatch": return `unauthorized: gateway token mismatch (${tokenHint})`;
		case "token_missing_config": return "unauthorized: gateway token not configured on gateway (set gateway.auth.token)";
		case "password_missing": return `unauthorized: gateway password missing (${passwordHint})`;
		case "password_mismatch": return `unauthorized: gateway password mismatch (${passwordHint})`;
		case "password_missing_config": return "unauthorized: gateway password not configured on gateway (set gateway.auth.password)";
		case "bootstrap_token_invalid": return "unauthorized: bootstrap token invalid or expired (scan a fresh setup code)";
		case "tailscale_user_missing": return "unauthorized: tailscale identity missing (use Tailscale Serve auth or gateway token/password)";
		case "tailscale_proxy_missing": return "unauthorized: tailscale proxy headers missing (use Tailscale Serve or gateway token/password)";
		case "tailscale_whois_failed": return "unauthorized: tailscale identity check failed (use Tailscale Serve auth or gateway token/password)";
		case "tailscale_user_mismatch": return "unauthorized: tailscale identity mismatch (use Tailscale Serve auth or gateway token/password)";
		case "rate_limited": return "unauthorized: too many failed authentication attempts (retry later)";
		case "device_token_mismatch": return "unauthorized: device token mismatch (rotate/reissue device token)";
		case "scope_mismatch": return "unauthorized: device token scope mismatch (re-pair or approve scope upgrade)";
		default: break;
	}
	if (authMode === "token" && authProvided === "none") return `unauthorized: gateway token missing (${tokenHint})`;
	if (authMode === "token" && authProvided === "device-token") return "unauthorized: device token rejected (pair/repair this device, or provide gateway token)";
	if (authProvided === "bootstrap-token") return "unauthorized: bootstrap token invalid or expired (scan a fresh setup code)";
	if (authMode === "password" && authProvided === "none") return `unauthorized: gateway password missing (${passwordHint})`;
	return "unauthorized";
}
//#endregion
//#region src/gateway/server/ws-connection/connect-policy.ts
function resolveControlUiAuthPolicy(params) {
	const allowInsecureAuthConfigured = params.isControlUi && params.controlUiConfig?.allowInsecureAuth === true;
	const dangerouslyDisableDeviceAuth = params.isControlUi && params.controlUiConfig?.dangerouslyDisableDeviceAuth === true;
	return {
		isControlUi: params.isControlUi,
		allowInsecureAuthConfigured,
		dangerouslyDisableDeviceAuth,
		allowBypass: dangerouslyDisableDeviceAuth,
		device: dangerouslyDisableDeviceAuth ? null : params.deviceRaw
	};
}
function shouldSkipControlUiPairing(policy, role, _trustedProxyAuthOk = false, authMode, authMethod) {
	if (policy.isControlUi && role === "operator" && authMethod === "tailscale" && policy.device) return true;
	if (policy.isControlUi && role === "operator" && authMode === "none") return true;
	return role === "operator" && policy.allowBypass;
}
function isTrustedProxyControlUiOperatorAuth(params) {
	return params.isControlUi && params.role === "operator" && params.authMode === "trusted-proxy" && params.authOk && params.authMethod === "trusted-proxy";
}
function shouldClearUnboundScopesForMissingDeviceIdentity(params) {
	return params.decision.kind !== "allow" || !params.controlUiAuthPolicy.allowBypass && !params.preserveInsecureLocalControlUiScopes && (params.authMethod === "token" || params.authMethod === "password" || params.authMethod === "trusted-proxy");
}
function evaluateMissingDeviceIdentity(params) {
	if (params.hasDeviceIdentity) return { kind: "allow" };
	if (params.isControlUi && params.trustedProxyAuthOk) return { kind: "allow" };
	if (params.isControlUi && params.controlUiAuthPolicy.allowBypass && params.role === "operator") return { kind: "allow" };
	if (params.localBackendSelfPairingOk && params.role === "operator") return { kind: "allow" };
	if (params.isControlUi && !params.controlUiAuthPolicy.allowBypass) {
		if (!params.controlUiAuthPolicy.allowInsecureAuthConfigured || !params.isLocalClient) return { kind: "reject-control-ui-insecure-auth" };
	}
	if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };
	if (!params.authOk && params.hasSharedAuth) return { kind: "reject-unauthorized" };
	return { kind: "reject-device-required" };
}
//#endregion
//#region src/gateway/server/ws-connection/handshake-auth-helpers.ts
const BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP = "198.18.0.1";
const BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX = "browser-origin:";
function resolveBrowserOriginRateLimitKey(requestOrigin) {
	const trimmedOrigin = requestOrigin?.trim();
	if (!trimmedOrigin) return BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP;
	try {
		return `${BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX}${normalizeLowercaseStringOrEmpty(new URL(trimmedOrigin).origin)}`;
	} catch {
		return BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP;
	}
}
function resolveHandshakeBrowserSecurityContext(params) {
	const hasBrowserOriginHeader = Boolean(params.requestOrigin && params.requestOrigin.trim() !== "");
	return {
		hasBrowserOriginHeader,
		enforceOriginCheckForAnyClient: hasBrowserOriginHeader,
		rateLimitClientIp: hasBrowserOriginHeader && isLoopbackAddress(params.clientIp) ? resolveBrowserOriginRateLimitKey(params.requestOrigin) : params.clientIp,
		authRateLimiter: hasBrowserOriginHeader && params.browserRateLimiter ? params.browserRateLimiter : params.rateLimiter
	};
}
function shouldAllowSilentLocalPairing(params) {
	if (params.locality === "remote") return false;
	if (params.hasBrowserOriginHeader && !params.isControlUi && !params.isWebchat) return false;
	if (params.reason === "not-paired" || params.reason === "scope-upgrade" || params.reason === "role-upgrade") return true;
	if (params.reason === "metadata-upgrade" && !params.hasBrowserOriginHeader && !params.isControlUi && !params.isWebchat && (params.locality === "direct_local" && params.isNativeAppUi === true || params.locality === "cli_container_local" || params.locality === "shared_secret_loopback_local")) return true;
	return false;
}
function isCliContainerLocalEquivalent(params) {
	const isCliClient = params.connectParams.client.id === GATEWAY_CLIENT_IDS.CLI && params.connectParams.client.mode === GATEWAY_CLIENT_MODES.CLI;
	const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
	return isCliClient && params.sharedAuthOk && usesSharedSecretAuth && !params.hasProxyHeaders && !params.hasBrowserOriginHeader && isLoopbackAddress(params.remoteAddress) && isPrivateOrLoopbackHost(resolveHostName(params.requestHost));
}
function isSharedSecretLoopbackLocalEquivalent(params) {
	const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
	return params.sharedAuthOk && usesSharedSecretAuth && !params.hasProxyHeaders && !params.hasBrowserOriginHeader && isLoopbackAddress(params.remoteAddress) && isPrivateOrLoopbackHost(resolveHostName(params.requestHost));
}
function resolveOriginHost(origin) {
	const trimmed = origin?.trim();
	if (!trimmed) return "";
	try {
		return new URL(trimmed).hostname;
	} catch {
		return "";
	}
}
function isControlUiBrowserContainerLocalEquivalent(params) {
	const isControlUiBrowser = params.connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI && params.connectParams.client.mode === GATEWAY_CLIENT_MODES.WEBCHAT;
	const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
	return isControlUiBrowser && params.sharedAuthOk && usesSharedSecretAuth && !params.hasProxyHeaders && params.hasBrowserOriginHeader && isPrivateOrLoopbackAddress(params.remoteAddress) && isLoopbackHost(resolveHostName(params.requestHost)) && isLoopbackHost(resolveOriginHost(params.requestOrigin));
}
function resolvePairingLocality(params) {
	if (params.isLocalClient) return "direct_local";
	if (isControlUiBrowserContainerLocalEquivalent({
		connectParams: params.connectParams,
		requestHost: params.requestHost,
		requestOrigin: params.requestOrigin,
		remoteAddress: params.remoteAddress,
		hasProxyHeaders: params.hasProxyHeaders,
		hasBrowserOriginHeader: params.hasBrowserOriginHeader,
		sharedAuthOk: params.sharedAuthOk,
		authMethod: params.authMethod
	})) return "browser_container_local";
	if (isCliContainerLocalEquivalent({
		connectParams: params.connectParams,
		requestHost: params.requestHost,
		remoteAddress: params.remoteAddress,
		hasProxyHeaders: params.hasProxyHeaders,
		hasBrowserOriginHeader: params.hasBrowserOriginHeader,
		sharedAuthOk: params.sharedAuthOk,
		authMethod: params.authMethod
	})) return "cli_container_local";
	if (isSharedSecretLoopbackLocalEquivalent({
		requestHost: params.requestHost,
		remoteAddress: params.remoteAddress,
		hasProxyHeaders: params.hasProxyHeaders,
		hasBrowserOriginHeader: params.hasBrowserOriginHeader,
		sharedAuthOk: params.sharedAuthOk,
		authMethod: params.authMethod
	})) return "shared_secret_loopback_local";
	return "remote";
}
function shouldSkipLocalBackendSelfPairing(params) {
	if (!(params.connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT && params.connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND)) return false;
	if (!(params.locality === "direct_local" || params.locality === "shared_secret_loopback_local") || params.hasBrowserOriginHeader) return false;
	if (params.authMethod === "none") return true;
	const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
	const usesDeviceTokenAuth = params.authMethod === "device-token";
	return params.sharedAuthOk && usesSharedSecretAuth || usesDeviceTokenAuth;
}
function resolveSignatureToken(connectParams) {
	return connectParams.auth?.token ?? connectParams.auth?.deviceToken ?? connectParams.auth?.bootstrapToken ?? null;
}
function buildUnauthorizedHandshakeContext(params) {
	return {
		authProvided: params.authProvided,
		canRetryWithDeviceToken: params.canRetryWithDeviceToken,
		recommendedNextStep: params.recommendedNextStep
	};
}
function resolveDeviceSignaturePayloadVersion(params) {
	const signatureToken = resolveSignatureToken(params.connectParams);
	const basePayload = {
		deviceId: params.device.id,
		clientId: params.connectParams.client.id,
		clientMode: params.connectParams.client.mode,
		role: params.role,
		scopes: params.scopes,
		signedAtMs: params.signedAtMs,
		token: signatureToken,
		nonce: params.nonce
	};
	const payloadV3 = buildDeviceAuthPayloadV3({
		...basePayload,
		platform: params.connectParams.client.platform,
		deviceFamily: params.connectParams.client.deviceFamily
	});
	if (verifyDeviceSignature(params.device.publicKey, payloadV3, params.device.signature)) return "v3";
	const payloadV2 = buildDeviceAuthPayload(basePayload);
	if (verifyDeviceSignature(params.device.publicKey, payloadV2, params.device.signature)) return "v2";
	return null;
}
function resolveAuthProvidedKind(connectAuth) {
	return connectAuth?.password ? "password" : connectAuth?.token ? "token" : connectAuth?.bootstrapToken ? "bootstrap-token" : connectAuth?.deviceToken ? "device-token" : "none";
}
function resolveUnauthorizedHandshakeContext(params) {
	const authProvided = resolveAuthProvidedKind(params.connectAuth);
	const canRetryWithDeviceToken = params.failedAuth.reason === "token_mismatch" && params.hasDeviceIdentity && authProvided === "token" && !params.connectAuth?.deviceToken;
	if (canRetryWithDeviceToken) return buildUnauthorizedHandshakeContext({
		authProvided,
		canRetryWithDeviceToken,
		recommendedNextStep: "retry_with_device_token"
	});
	switch (params.failedAuth.reason) {
		case "token_missing":
		case "token_missing_config":
		case "password_missing":
		case "password_missing_config": return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "update_auth_configuration"
		});
		case "token_mismatch":
		case "password_mismatch":
		case "device_token_mismatch": return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "update_auth_credentials"
		});
		case "scope_mismatch": return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "review_auth_configuration"
		});
		case "rate_limited": return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "wait_then_retry"
		});
		default: return buildUnauthorizedHandshakeContext({
			authProvided,
			canRetryWithDeviceToken,
			recommendedNextStep: "review_auth_configuration"
		});
	}
}
//#endregion
//#region src/gateway/server/ws-connection/unauthorized-flood-guard.ts
const DEFAULT_CLOSE_AFTER = 10;
const DEFAULT_LOG_EVERY = 100;
var UnauthorizedFloodGuard = class {
	constructor(options) {
		this.count = 0;
		this.suppressedSinceLastLog = 0;
		this.closeAfter = Math.max(1, Math.floor(options?.closeAfter ?? DEFAULT_CLOSE_AFTER));
		this.logEvery = Math.max(1, Math.floor(options?.logEvery ?? DEFAULT_LOG_EVERY));
	}
	registerUnauthorized() {
		this.count += 1;
		const shouldClose = this.count > this.closeAfter;
		if (!(this.count === 1 || this.count % this.logEvery === 0 || shouldClose)) {
			this.suppressedSinceLastLog += 1;
			return {
				shouldClose,
				shouldLog: false,
				count: this.count,
				suppressedSinceLastLog: 0
			};
		}
		const suppressedSinceLastLog = this.suppressedSinceLastLog;
		this.suppressedSinceLastLog = 0;
		return {
			shouldClose,
			shouldLog: true,
			count: this.count,
			suppressedSinceLastLog
		};
	}
	reset() {
		this.count = 0;
		this.suppressedSinceLastLog = 0;
	}
};
function isUnauthorizedRoleError(error) {
	if (!error) return false;
	return error.code === ErrorCodes.INVALID_REQUEST && typeof error.message === "string" && error.message.startsWith("unauthorized role:");
}
//#endregion
//#region src/gateway/server/ws-connection/message-handler.ts
const DEVICE_SIGNATURE_SKEW_MS = 120 * 1e3;
function sameBootstrapProfile(left, right) {
	if (left.roles.length !== right.roles.length || left.scopes.length !== right.scopes.length) return false;
	return left.roles.every((role, index) => role === right.roles[index]) && left.scopes.every((scope, index) => scope === right.scopes[index]);
}
function firstHeaderValue(value) {
	return Array.isArray(value) ? value[0] : value;
}
function resolveTrustedProxyControlUiScopes(params) {
	const rawHeader = firstHeaderValue(params.upgradeReq.headers["x-openclaw-scopes"]);
	if (rawHeader === void 0) return params.requestedScopes;
	const declaredScopes = new Set(rawHeader.split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0));
	if (declaredScopes.size === 0) return [];
	return params.requestedScopes.filter((scope) => declaredScopes.has(scope));
}
function resolvePinnedClientMetadata(params) {
	function normalizeLegacyNodeHostPlatformPin(value) {
		switch (value) {
			case "darwin":
			case "macos": return "macos";
			case "win32":
			case "windows": return "windows";
			default: return value;
		}
	}
	function normalizeMobileAppPlatformPin(clientId, value) {
		if (clientId === GATEWAY_CLIENT_IDS.IOS_APP && /^(?:ios|ipados)(?:\s|$)/.test(value)) return "ios-family";
		if (clientId === GATEWAY_CLIENT_IDS.ANDROID_APP && /^android(?:\s|$)/.test(value)) return "android";
		return value;
	}
	const claimedPlatform = normalizeDeviceMetadataForAuth(params.claimedPlatform);
	const claimedDeviceFamily = normalizeDeviceMetadataForAuth(params.claimedDeviceFamily);
	const pairedPlatform = normalizeDeviceMetadataForAuth(params.pairedPlatform);
	const pairedDeviceFamily = normalizeDeviceMetadataForAuth(params.pairedDeviceFamily);
	const hasPinnedPlatform = pairedPlatform !== "";
	const hasPinnedDeviceFamily = pairedDeviceFamily !== "";
	const isLegacyNodeHostPlatformPin = params.clientId === GATEWAY_CLIENT_IDS.NODE_HOST && params.clientMode === GATEWAY_CLIENT_MODES.NODE && hasPinnedPlatform && claimedPlatform !== "" && normalizeLegacyNodeHostPlatformPin(claimedPlatform) === normalizeLegacyNodeHostPlatformPin(pairedPlatform);
	const isMobileAppPlatformVersionRefresh = hasPinnedPlatform && claimedPlatform !== "" && claimedPlatform !== pairedPlatform && normalizeMobileAppPlatformPin(params.clientId, claimedPlatform) === normalizeMobileAppPlatformPin(params.clientId, pairedPlatform);
	const platformMismatch = hasPinnedPlatform && claimedPlatform !== pairedPlatform && !isLegacyNodeHostPlatformPin && !isMobileAppPlatformVersionRefresh;
	const deviceFamilyMismatch = hasPinnedDeviceFamily && claimedDeviceFamily !== pairedDeviceFamily;
	const pinnedPlatform = claimedPlatform === pairedPlatform ? params.pairedPlatform : isLegacyNodeHostPlatformPin ? normalizeLegacyNodeHostPlatformPin(pairedPlatform) : isMobileAppPlatformVersionRefresh ? params.claimedPlatform : void 0;
	return {
		platformMismatch,
		deviceFamilyMismatch,
		pinnedPlatform: hasPinnedPlatform ? pinnedPlatform : void 0,
		pinnedDeviceFamily: hasPinnedDeviceFamily ? params.pairedDeviceFamily : void 0,
		...isMobileAppPlatformVersionRefresh ? { refreshPairedPlatform: params.claimedPlatform } : {}
	};
}
function attachGatewayWsMessageHandler(params) {
	const { socket, upgradeReq, connId, remoteAddr, remotePort, localAddr, localPort, endpoint, forwardedFor, realIp, requestHost, requestOrigin, requestUserAgent, pluginSurfaceBaseUrl, pluginNodeCapabilities = [], connectNonce, getResolvedAuth, getRequiredSharedGatewaySessionGeneration, rateLimiter, browserRateLimiter, isStartupPending, gatewayMethods, events, extraHandlers, getMethodRegistry, buildRequestContext, refreshHealthSnapshot, send, close, isClosed, clearHandshakeTimer, getClient, setClient, setHandshakeState, setCloseCause, setLastFrameMeta, originCheckMetrics, logGateway, logHealth, logWsControl } = params;
	const sendFrame = async (obj) => await new Promise((resolve, reject) => {
		socket.send(JSON.stringify(obj), (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
	const configSnapshot = getRuntimeConfig();
	const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
	const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
	const clientIp = resolveClientIp({
		remoteAddr,
		forwardedFor,
		realIp,
		trustedProxies,
		allowRealIpFallback
	});
	const peerLabel = endpoint ?? remoteAddr ?? "n/a";
	const hasProxyHeaders = hasForwardedRequestHeaders(upgradeReq);
	const remoteIsTrustedProxy = isTrustedProxyAddress(remoteAddr, trustedProxies);
	const hasUntrustedProxyHeaders = hasProxyHeaders && !remoteIsTrustedProxy;
	const hostIsLocalish = isLocalishHost(requestHost);
	const isLocalClient = isLocalDirectRequest(upgradeReq, trustedProxies, allowRealIpFallback);
	const reportedClientIp = isLocalClient || hasUntrustedProxyHeaders ? void 0 : clientIp && !isLoopbackAddress(clientIp) ? clientIp : void 0;
	const reportedClientIpSource = resolveNodePairingClientIpSource({
		reportedClientIp,
		hasProxyHeaders,
		remoteIsTrustedProxy,
		remoteIsLoopback: isLoopbackAddress(remoteAddr)
	});
	if (hasUntrustedProxyHeaders) logWsControl.warn("Proxy headers detected from untrusted address. Connection will not be treated as local. Configure gateway.trustedProxies to restore local client detection behind your proxy.");
	if (!hostIsLocalish && isLoopbackAddress(remoteAddr) && !hasProxyHeaders) logWsControl.warn("Loopback connection with non-local Host header. Treating it as remote. If you're behind a reverse proxy, set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.");
	const isWebchatConnect = (p) => isWebchatClient(p?.client);
	const unauthorizedFloodGuard = new UnauthorizedFloodGuard();
	const { hasBrowserOriginHeader, enforceOriginCheckForAnyClient, rateLimitClientIp: browserRateLimitClientIp, authRateLimiter } = resolveHandshakeBrowserSecurityContext({
		requestOrigin,
		clientIp,
		rateLimiter,
		browserRateLimiter
	});
	const handleMessage = async (data) => {
		if (isClosed()) return;
		const preauthPayloadBytes = !getClient() ? getRawDataByteLength(data) : void 0;
		if (preauthPayloadBytes !== void 0 && preauthPayloadBytes > 65536) {
			logRejectedLargePayload({
				surface: "gateway.ws.preauth",
				bytes: preauthPayloadBytes,
				limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
				reason: "preauth_frame_limit"
			});
			setHandshakeState("failed");
			setCloseCause("preauth-payload-too-large", {
				payloadBytes: preauthPayloadBytes,
				limitBytes: MAX_PREAUTH_PAYLOAD_BYTES
			});
			close(1009, "preauth payload too large");
			return;
		}
		const text = rawDataToString(data);
		try {
			const parsed = JSON.parse(text);
			const frameType = parsed && typeof parsed === "object" && "type" in parsed ? typeof parsed.type === "string" ? String(parsed.type) : void 0 : void 0;
			const frameMethod = parsed && typeof parsed === "object" && "method" in parsed ? typeof parsed.method === "string" ? String(parsed.method) : void 0 : void 0;
			const frameId = parsed && typeof parsed === "object" && "id" in parsed ? typeof parsed.id === "string" ? String(parsed.id) : void 0 : void 0;
			if (frameType || frameMethod || frameId) setLastFrameMeta({
				type: frameType,
				method: frameMethod,
				id: frameId
			});
			const client = getClient();
			if (!client) {
				const isRequestFrame = validateRequestFrame(parsed);
				if (!isRequestFrame || parsed.method !== "connect" || !validateConnectParams(parsed.params)) {
					const handshakeError = isRequestFrame ? parsed.method === "connect" ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}` : "invalid handshake: first request must be connect" : "invalid request frame";
					setHandshakeState("failed");
					setCloseCause("invalid-handshake", {
						frameType,
						frameMethod,
						frameId,
						handshakeError
					});
					if (isRequestFrame) send({
						type: "res",
						id: parsed.id,
						ok: false,
						error: errorShape(ErrorCodes.INVALID_REQUEST, handshakeError)
					});
					else logWsControl.warn(`invalid handshake conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} fwd=${formatForLog(forwardedFor ?? "n/a")} origin=${formatForLog(requestOrigin ?? "n/a")} host=${formatForLog(requestHost ?? "n/a")} ua=${formatForLog(requestUserAgent ?? "n/a")}`);
					const closeReason = truncateCloseReason(handshakeError || "invalid handshake");
					if (isRequestFrame) queueMicrotask(() => close(1008, closeReason));
					else close(1008, closeReason);
					return;
				}
				const frame = parsed;
				const connectParams = frame.params;
				const resolvedAuth = getResolvedAuth();
				const clientLabel = connectParams.client.displayName ?? connectParams.client.id;
				const clientMeta = {
					client: connectParams.client.id,
					clientDisplayName: connectParams.client.displayName,
					mode: connectParams.client.mode,
					version: connectParams.client.version,
					platform: connectParams.client.platform,
					deviceFamily: connectParams.client.deviceFamily,
					modelIdentifier: connectParams.client.modelIdentifier,
					instanceId: connectParams.client.instanceId
				};
				const markHandshakeFailure = (cause, meta) => {
					setHandshakeState("failed");
					setCloseCause(cause, {
						...meta,
						...clientMeta
					});
				};
				const sendHandshakeErrorResponse = (code, message, options) => {
					send({
						type: "res",
						id: frame.id,
						ok: false,
						error: errorShape(code, message, options)
					});
				};
				if (isStartupPending?.()) {
					markHandshakeFailure(GATEWAY_STARTUP_PENDING_CLOSE_CAUSE);
					await sendFrame({
						type: "res",
						id: frame.id,
						ok: false,
						error: errorShape(ErrorCodes.UNAVAILABLE, "gateway starting; retry shortly", {
							retryable: true,
							retryAfterMs: 500,
							details: gatewayStartupUnavailableDetails()
						})
					}).catch(() => {});
					queueMicrotask(() => close(GATEWAY_STARTUP_CLOSE_CODE, GATEWAY_STARTUP_CLOSE_REASON));
					return;
				}
				const { minProtocol, maxProtocol } = connectParams;
				const supportsCurrentProtocol = maxProtocol >= 4 && minProtocol <= 4;
				const supportsProbeRestartProtocol = connectParams.client.mode === GATEWAY_CLIENT_MODES.PROBE && maxProtocol >= 4 && minProtocol <= 4;
				if (!supportsCurrentProtocol && !supportsProbeRestartProtocol) {
					markHandshakeFailure("protocol-mismatch", {
						minProtocol,
						maxProtocol,
						expectedProtocol: 4,
						minimumProbeProtocol: 4
					});
					logWsControl.warn(`protocol mismatch conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} remotePort=${remotePort ?? "?"} client=${formatForLog(clientLabel)} ${connectParams.client.mode} v${formatForLog(connectParams.client.version)} min=${minProtocol} max=${maxProtocol} expected=4 probeMin=4 instance=${formatForLog(connectParams.client.instanceId ?? "n/a")}`);
					sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch", { details: {
						code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
						clientMinProtocol: minProtocol,
						clientMaxProtocol: maxProtocol,
						expectedProtocol: 4,
						minimumProbeProtocol: 4
					} });
					close(1002, "protocol mismatch");
					return;
				}
				const roleRaw = connectParams.role ?? "operator";
				const role = parseGatewayRole(roleRaw);
				if (!role) {
					markHandshakeFailure("invalid-role", { role: roleRaw });
					sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "invalid role");
					close(1008, "invalid role");
					return;
				}
				let scopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
				connectParams.role = role;
				connectParams.scopes = scopes;
				const isControlUi = isOperatorUiClient(connectParams.client);
				const isBrowserOperatorUi = isBrowserOperatorUiClient(connectParams.client);
				const isWebchat = isWebchatConnect(connectParams);
				const isNativeAppUi = connectParams.client.mode === GATEWAY_CLIENT_MODES.UI && (connectParams.client.id === GATEWAY_CLIENT_IDS.MACOS_APP || connectParams.client.id === GATEWAY_CLIENT_IDS.IOS_APP || connectParams.client.id === GATEWAY_CLIENT_IDS.ANDROID_APP);
				if (enforceOriginCheckForAnyClient || isBrowserOperatorUi || isWebchat) {
					const hostHeaderOriginFallbackEnabled = configSnapshot.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
					const originCheck = checkBrowserOrigin({
						requestHost,
						origin: requestOrigin,
						allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
						allowHostHeaderOriginFallback: hostHeaderOriginFallbackEnabled,
						isLocalClient
					});
					if (!originCheck.ok) {
						const errorMessage = "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
						markHandshakeFailure("origin-mismatch", {
							origin: requestOrigin ?? "n/a",
							host: requestHost ?? "n/a",
							reason: originCheck.reason
						});
						sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, { details: {
							code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
							reason: originCheck.reason
						} });
						close(1008, truncateCloseReason(errorMessage));
						return;
					}
					if (originCheck.matchedBy === "host-header-fallback") {
						originCheckMetrics.hostHeaderFallbackAccepted += 1;
						logWsControl.warn(`security warning: websocket origin accepted via Host-header fallback conn=${connId} count=${originCheckMetrics.hostHeaderFallbackAccepted} host=${requestHost ?? "n/a"} origin=${requestOrigin ?? "n/a"}`);
						if (hostHeaderOriginFallbackEnabled) logGateway.warn("security metric: gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback accepted a websocket connect request");
					}
				}
				const deviceRaw = connectParams.device;
				let devicePublicKey = null;
				let deviceAuthPayloadVersion = null;
				const hasTokenAuth = Boolean(connectParams.auth?.token);
				const hasPasswordAuth = Boolean(connectParams.auth?.password);
				const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
				const controlUiAuthPolicy = resolveControlUiAuthPolicy({
					isControlUi,
					controlUiConfig: configSnapshot.gateway?.controlUi,
					deviceRaw
				});
				const device = controlUiAuthPolicy.device;
				let { authResult, authOk, authMethod, sharedAuthOk, bootstrapTokenCandidate, deviceTokenCandidate, deviceTokenCandidateSource } = await resolveConnectAuthState({
					resolvedAuth,
					connectAuth: connectParams.auth,
					hasDeviceIdentity: Boolean(device),
					req: upgradeReq,
					trustedProxies,
					allowRealIpFallback,
					rateLimiter: authRateLimiter,
					clientIp: browserRateLimitClientIp
				});
				const rejectUnauthorized = (failedAuth) => {
					const { authProvided, canRetryWithDeviceToken, recommendedNextStep } = resolveUnauthorizedHandshakeContext({
						connectAuth: connectParams.auth,
						failedAuth,
						hasDeviceIdentity: Boolean(device)
					});
					markHandshakeFailure("unauthorized", {
						authMode: resolvedAuth.mode,
						authProvided,
						authReason: failedAuth.reason,
						allowTailscale: resolvedAuth.allowTailscale,
						peer: peerLabel,
						remoteAddr,
						remotePort,
						localAddr,
						localPort,
						role,
						scopeCount: scopes.length,
						hasDeviceIdentity: Boolean(device)
					});
					logWsControl.warn(`unauthorized conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} client=${formatForLog(clientLabel)} ${connectParams.client.mode} v${formatForLog(connectParams.client.version)} role=${role} scopes=${scopes.length} auth=${authProvided} device=${device ? "yes" : "no"} platform=${formatForLog(connectParams.client.platform)} instance=${formatForLog(connectParams.client.instanceId ?? "n/a")} host=${formatForLog(requestHost ?? "n/a")} origin=${formatForLog(requestOrigin ?? "n/a")} ua=${formatForLog(requestUserAgent ?? "n/a")} reason=${failedAuth.reason ?? "unknown"}`);
					const authMessage = formatGatewayAuthFailureMessage({
						authMode: resolvedAuth.mode,
						authProvided,
						reason: failedAuth.reason,
						client: connectParams.client
					});
					sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, authMessage, { details: {
						code: resolveAuthConnectErrorDetailCode(failedAuth.reason),
						authReason: failedAuth.reason,
						canRetryWithDeviceToken,
						recommendedNextStep
					} });
					close(1008, truncateCloseReason(authMessage));
				};
				const clearUnboundScopes = () => {
					if (scopes.length > 0) {
						scopes = [];
						connectParams.scopes = scopes;
					}
				};
				let pairingLocality = resolvePairingLocality({
					connectParams,
					isLocalClient,
					requestHost,
					requestOrigin,
					remoteAddress: remoteAddr,
					hasProxyHeaders,
					hasBrowserOriginHeader,
					sharedAuthOk,
					authMethod
				});
				let skipLocalBackendSelfPairing = shouldSkipLocalBackendSelfPairing({
					connectParams,
					locality: pairingLocality,
					hasBrowserOriginHeader,
					sharedAuthOk,
					authMethod
				});
				const handleMissingDeviceIdentity = () => {
					const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
						isControlUi,
						role,
						authMode: resolvedAuth.mode,
						authOk,
						authMethod
					});
					const preserveInsecureLocalControlUiScopes = isControlUi && controlUiAuthPolicy.allowInsecureAuthConfigured && isLocalClient && (authMethod === "token" || authMethod === "password");
					const decision = evaluateMissingDeviceIdentity({
						hasDeviceIdentity: Boolean(device),
						role,
						isControlUi,
						controlUiAuthPolicy,
						trustedProxyAuthOk,
						localBackendSelfPairingOk: skipLocalBackendSelfPairing,
						sharedAuthOk,
						authOk,
						hasSharedAuth,
						isLocalClient
					});
					if (!device && !skipLocalBackendSelfPairing && shouldClearUnboundScopesForMissingDeviceIdentity({
						decision,
						controlUiAuthPolicy,
						preserveInsecureLocalControlUiScopes,
						authMethod,
						trustedProxyAuthOk
					})) clearUnboundScopes();
					if (decision.kind === "allow") return true;
					if (decision.kind === "reject-control-ui-insecure-auth") {
						const errorMessage = "control ui requires device identity (use HTTPS or localhost secure context)";
						markHandshakeFailure("control-ui-insecure-auth", { insecureAuthConfigured: controlUiAuthPolicy.allowInsecureAuthConfigured });
						sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, { details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED } });
						close(1008, errorMessage);
						return false;
					}
					if (decision.kind === "reject-unauthorized") {
						rejectUnauthorized(authResult);
						return false;
					}
					markHandshakeFailure("device-required");
					sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, "device identity required", { details: { code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED } });
					close(1008, "device identity required");
					return false;
				};
				if (!handleMissingDeviceIdentity()) return;
				if (device) {
					const rejectDeviceAuthInvalid = (reason, message) => {
						setHandshakeState("failed");
						setCloseCause("device-auth-invalid", {
							reason,
							client: connectParams.client.id,
							deviceId: device.id
						});
						send({
							type: "res",
							id: frame.id,
							ok: false,
							error: errorShape(ErrorCodes.INVALID_REQUEST, message, { details: {
								code: resolveDeviceAuthConnectErrorDetailCode(reason),
								reason
							} })
						});
						close(1008, message);
					};
					const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
					if (!derivedId || derivedId !== device.id) {
						rejectDeviceAuthInvalid("device-id-mismatch", "device identity mismatch");
						return;
					}
					const signedAt = device.signedAt;
					if (typeof signedAt !== "number" || Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS) {
						rejectDeviceAuthInvalid("device-signature-stale", "device signature expired");
						return;
					}
					const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
					if (!providedNonce) {
						rejectDeviceAuthInvalid("device-nonce-missing", "device nonce required");
						return;
					}
					if (providedNonce !== connectNonce) {
						rejectDeviceAuthInvalid("device-nonce-mismatch", "device nonce mismatch");
						return;
					}
					const rejectDeviceSignatureInvalid = () => rejectDeviceAuthInvalid("device-signature", "device signature invalid");
					const payloadVersion = resolveDeviceSignaturePayloadVersion({
						device,
						connectParams,
						role,
						scopes,
						signedAtMs: signedAt,
						nonce: providedNonce
					});
					if (!payloadVersion) {
						rejectDeviceSignatureInvalid();
						return;
					}
					deviceAuthPayloadVersion = payloadVersion;
					devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
					if (!devicePublicKey) {
						rejectDeviceAuthInvalid("device-public-key", "device public key invalid");
						return;
					}
				}
				({authResult, authOk, authMethod} = await resolveConnectAuthDecision({
					state: {
						authResult,
						authOk,
						authMethod,
						sharedAuthOk,
						sharedAuthProvided: hasSharedAuth,
						bootstrapTokenCandidate,
						deviceTokenCandidate,
						deviceTokenCandidateSource
					},
					hasDeviceIdentity: Boolean(device),
					deviceId: device?.id,
					publicKey: device?.publicKey,
					role,
					scopes,
					rateLimiter: authRateLimiter,
					clientIp: browserRateLimitClientIp,
					verifyBootstrapToken: async ({ deviceId, publicKey, token, role, scopes }) => await verifyDeviceBootstrapToken({
						deviceId,
						publicKey,
						token,
						role,
						scopes
					}),
					verifyDeviceToken
				}));
				pairingLocality = resolvePairingLocality({
					connectParams,
					isLocalClient,
					requestHost,
					requestOrigin,
					remoteAddress: remoteAddr,
					hasProxyHeaders,
					hasBrowserOriginHeader,
					sharedAuthOk,
					authMethod
				});
				skipLocalBackendSelfPairing = shouldSkipLocalBackendSelfPairing({
					connectParams,
					locality: pairingLocality,
					hasBrowserOriginHeader,
					sharedAuthOk,
					authMethod
				});
				if (!authOk) {
					rejectUnauthorized(authResult);
					return;
				}
				if (authMethod === "token" || authMethod === "password" || authMethod === "trusted-proxy") {
					const sharedGatewaySessionGeneration = resolveSharedGatewaySessionGeneration(resolvedAuth, trustedProxies);
					const requiredSharedGatewaySessionGeneration = getRequiredSharedGatewaySessionGeneration?.();
					if (requiredSharedGatewaySessionGeneration !== void 0 && sharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration) {
						setCloseCause("gateway-auth-rotated", { authGenerationStale: true });
						close(4001, "gateway auth changed");
						return;
					}
				}
				const issuedBootstrapProfile = authMethod === "bootstrap-token" && bootstrapTokenCandidate ? await getDeviceBootstrapTokenProfile({ token: bootstrapTokenCandidate }) : null;
				let handoffBootstrapProfile = null;
				const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
					isControlUi,
					role,
					authMode: resolvedAuth.mode,
					authOk,
					authMethod
				});
				if (trustedProxyAuthOk) {
					scopes = resolveTrustedProxyControlUiScopes({
						requestedScopes: scopes,
						upgradeReq
					});
					connectParams.scopes = scopes;
				}
				const skipControlUiPairingForDevice = shouldSkipControlUiPairing(controlUiAuthPolicy, role, trustedProxyAuthOk, resolvedAuth.mode, authMethod);
				let hasServerApprovedDeviceTokenBaseline = false;
				if (device && devicePublicKey) {
					const formatAuditList = (items) => {
						if (!items || items.length === 0) return "<none>";
						const out = /* @__PURE__ */ new Set();
						for (const item of items) {
							const trimmed = item.trim();
							if (trimmed) out.add(trimmed);
						}
						if (out.size === 0) return "<none>";
						return [...out].toSorted().join(",");
					};
					const logUpgradeAudit = (reason, currentRoles, currentScopes) => {
						logGateway.warn(`security audit: device access upgrade requested reason=${reason} device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} roleFrom=${formatAuditList(currentRoles)} roleTo=${role} scopesFrom=${formatAuditList(currentScopes)} scopesTo=${formatAuditList(scopes)} client=${connectParams.client.id} conn=${connId}`);
					};
					const clientPairingMetadata = {
						displayName: connectParams.client.displayName,
						platform: connectParams.client.platform,
						deviceFamily: connectParams.client.deviceFamily,
						clientId: connectParams.client.id,
						clientMode: connectParams.client.mode,
						role,
						scopes,
						remoteIp: reportedClientIp
					};
					const clientAccessMetadata = {
						displayName: connectParams.client.displayName,
						remoteIp: reportedClientIp
					};
					const requirePairing = async (reason, existingPairedDevice = null) => {
						const pairingStateAllowsRequestedAccess = (pairedCandidate) => {
							if (!pairedCandidate || pairedCandidate.publicKey !== devicePublicKey) return false;
							if (!hasEffectivePairedDeviceRole(pairedCandidate, role)) return false;
							if (scopes.length === 0) return true;
							const pairedScopes = Array.isArray(pairedCandidate.approvedScopes) ? pairedCandidate.approvedScopes : Array.isArray(pairedCandidate.scopes) ? pairedCandidate.scopes : [];
							if (pairedScopes.length === 0) return false;
							return roleScopesAllow({
								role,
								requestedScopes: scopes,
								allowedScopes: pairedScopes
							});
						};
						const allowSilentLocalPairing = !(existingPairedDevice && role !== "operator") && shouldAllowSilentLocalPairing({
							locality: pairingLocality,
							hasBrowserOriginHeader,
							isControlUi,
							isWebchat,
							isNativeAppUi,
							reason
						});
						const allowSilentTrustedCidrsNodePairing = shouldAutoApproveNodePairingFromTrustedCidrs({
							existingPairedDevice: Boolean(existingPairedDevice),
							role,
							reason,
							scopes,
							hasBrowserOriginHeader,
							isControlUi,
							isWebchat,
							reportedClientIpSource,
							reportedClientIp,
							autoApproveCidrs: configSnapshot.gateway?.nodes?.pairing?.autoApproveCidrs
						});
						const boundBootstrapProfile = authMethod === "bootstrap-token" && bootstrapTokenCandidate && reason === "not-paired" && role === "node" && scopes.length === 0 && !existingPairedDevice && !isControlUi && !isBrowserOperatorUi && !isWebchat && connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE ? await getBoundDeviceBootstrapProfile({
							token: bootstrapTokenCandidate,
							deviceId: device.id,
							publicKey: devicePublicKey
						}) : null;
						const allowSilentBootstrapPairing = boundBootstrapProfile !== null && sameBootstrapProfile(boundBootstrapProfile, PAIRING_SETUP_BOOTSTRAP_PROFILE);
						const bootstrapPairingRoles = allowSilentBootstrapPairing ? Array.from(new Set([role, ...boundBootstrapProfile.roles])) : void 0;
						const pairing = await requestDevicePairing({
							deviceId: device.id,
							publicKey: devicePublicKey,
							...clientPairingMetadata,
							...bootstrapPairingRoles ? {
								roles: bootstrapPairingRoles,
								scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]
							} : {},
							silent: reason === "scope-upgrade" ? false : allowSilentLocalPairing || allowSilentTrustedCidrsNodePairing || allowSilentBootstrapPairing
						});
						const context = buildRequestContext();
						let approved;
						let resolvedByConcurrentApproval = false;
						let recoveryRequestId = pairing.request.requestId;
						const resolveLivePendingRequestId = async () => {
							const pendingList = await listDevicePairing();
							const exactPending = pendingList.pending.find((pending) => pending.requestId === pairing.request.requestId);
							if (exactPending) return exactPending.requestId;
							return pendingList.pending.find((pending) => pending.deviceId === device.id && pending.publicKey === devicePublicKey)?.requestId;
						};
						if (pairing.request.silent === true) {
							approved = allowSilentBootstrapPairing && boundBootstrapProfile ? await approveBootstrapDevicePairing(pairing.request.requestId, boundBootstrapProfile) : await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes });
							if (approved?.status === "approved") {
								if (allowSilentBootstrapPairing && boundBootstrapProfile) handoffBootstrapProfile = boundBootstrapProfile;
								logGateway.info(`device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`);
								context.broadcast("device.pair.resolved", {
									requestId: pairing.request.requestId,
									deviceId: approved.device.deviceId,
									decision: "approved",
									ts: Date.now()
								}, { dropIfSlow: true });
							} else {
								resolvedByConcurrentApproval = pairingStateAllowsRequestedAccess(await getPairedDevice(device.id));
								let requestStillPending = false;
								if (!resolvedByConcurrentApproval) {
									recoveryRequestId = await resolveLivePendingRequestId();
									requestStillPending = recoveryRequestId === pairing.request.requestId;
								}
								if (requestStillPending) context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
							}
						} else if (pairing.created) context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
						recoveryRequestId = await resolveLivePendingRequestId();
						if (!(pairing.request.silent === true && (approved?.status === "approved" || resolvedByConcurrentApproval))) {
							const exposeApprovedAccess = existingPairedDevice?.publicKey === devicePublicKey;
							const approvedRoles = exposeApprovedAccess ? listApprovedPairedDeviceRoles(existingPairedDevice) : [];
							const approvedScopes = exposeApprovedAccess ? Array.isArray(existingPairedDevice.approvedScopes) ? existingPairedDevice.approvedScopes : Array.isArray(existingPairedDevice.scopes) ? existingPairedDevice.scopes : [] : [];
							const retryAfterBootstrapPairingApproval = authMethod === "bootstrap-token" && reason === "not-paired" && role === "node" && scopes.length === 0 && !existingPairedDevice;
							const pairingErrorDetails = buildPairingConnectErrorDetails({
								reason,
								requestId: recoveryRequestId,
								...retryAfterBootstrapPairingApproval ? {
									recommendedNextStep: "wait_then_retry",
									retryable: true,
									pauseReconnect: false
								} : {},
								deviceId: device.id,
								requestedRole: role,
								requestedScopes: scopes,
								...approvedRoles.length > 0 ? { approvedRoles } : {},
								...approvedScopes.length > 0 ? { approvedScopes } : {}
							});
							const pairingErrorMessage = buildPairingConnectErrorMessage(reason);
							setHandshakeState("failed");
							setCloseCause("pairing-required", {
								deviceId: device.id,
								...recoveryRequestId ? { requestId: recoveryRequestId } : {},
								reason
							});
							send({
								type: "res",
								id: frame.id,
								ok: false,
								error: errorShape(ErrorCodes.NOT_PAIRED, pairingErrorMessage, { details: pairingErrorDetails })
							});
							close(1008, truncateCloseReason(buildPairingConnectCloseReason({
								reason,
								requestId: recoveryRequestId
							})));
							return false;
						}
						return true;
					};
					const paired = await getPairedDevice(device.id);
					if (!(paired?.publicKey === devicePublicKey)) {
						if (!(skipLocalBackendSelfPairing || skipControlUiPairingForDevice)) {
							if (!await requirePairing("not-paired", paired)) return;
							hasServerApprovedDeviceTokenBaseline = true;
						} else if (skipControlUiPairingForDevice || skipLocalBackendSelfPairing && authMethod !== "device-token") hasServerApprovedDeviceTokenBaseline = true;
					} else {
						hasServerApprovedDeviceTokenBaseline = true;
						const claimedPlatform = connectParams.client.platform;
						const pairedPlatform = paired.platform;
						const claimedDeviceFamily = connectParams.client.deviceFamily;
						const pairedDeviceFamily = paired.deviceFamily;
						const metadataPinning = resolvePinnedClientMetadata({
							clientId: connectParams.client.id,
							clientMode: connectParams.client.mode,
							claimedPlatform,
							claimedDeviceFamily,
							pairedPlatform,
							pairedDeviceFamily
						});
						const { platformMismatch, deviceFamilyMismatch } = metadataPinning;
						if (platformMismatch || deviceFamilyMismatch) {
							if (!shouldAllowSilentLocalPairing({
								locality: pairingLocality,
								hasBrowserOriginHeader,
								isControlUi,
								isWebchat,
								isNativeAppUi,
								reason: "metadata-upgrade"
							})) logGateway.warn(`security audit: device metadata upgrade requested reason=metadata-upgrade device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} payload=${deviceAuthPayloadVersion ?? "unknown"} claimedPlatform=${claimedPlatform ?? "<none>"} pinnedPlatform=${pairedPlatform ?? "<none>"} claimedDeviceFamily=${claimedDeviceFamily ?? "<none>"} pinnedDeviceFamily=${pairedDeviceFamily ?? "<none>"} client=${connectParams.client.id} conn=${connId}`);
							if (!await requirePairing("metadata-upgrade", paired)) return;
						} else {
							if (metadataPinning.pinnedPlatform) connectParams.client.platform = metadataPinning.pinnedPlatform;
							if (metadataPinning.pinnedDeviceFamily) connectParams.client.deviceFamily = metadataPinning.pinnedDeviceFamily;
						}
						const pairedRoles = listEffectivePairedDeviceRoles(paired);
						const pairedScopes = Array.isArray(paired.approvedScopes) ? paired.approvedScopes : Array.isArray(paired.scopes) ? paired.scopes : [];
						const allowedRoles = new Set(pairedRoles);
						if (allowedRoles.size === 0) {
							logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
							if (!await requirePairing("role-upgrade", paired)) return;
						} else if (!allowedRoles.has(role)) {
							logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
							if (!await requirePairing("role-upgrade", paired)) return;
						}
						if (scopes.length > 0) {
							if (pairedScopes.length === 0) {
								logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
								if (!await requirePairing("scope-upgrade", paired)) return;
							} else if (!roleScopesAllow({
								role,
								requestedScopes: scopes,
								allowedScopes: pairedScopes
							})) {
								logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
								if (!await requirePairing("scope-upgrade", paired)) return;
							}
						}
						const retryBootstrapHandoffProfile = authMethod === "bootstrap-token" && bootstrapTokenCandidate && role === "node" && scopes.length === 0 && !isControlUi && !isBrowserOperatorUi && !isWebchat && connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE && pairedRoles.includes("operator") && roleScopesAllow({
							role: "operator",
							requestedScopes: BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
							allowedScopes: pairedScopes
						}) ? await getBoundDeviceBootstrapProfile({
							token: bootstrapTokenCandidate,
							deviceId: device.id,
							publicKey: devicePublicKey
						}) : null;
						if (retryBootstrapHandoffProfile && sameBootstrapProfile(retryBootstrapHandoffProfile, PAIRING_SETUP_BOOTSTRAP_PROFILE)) handoffBootstrapProfile = retryBootstrapHandoffProfile;
						await updatePairedDeviceMetadata(device.id, {
							...clientAccessMetadata,
							...metadataPinning.refreshPairedPlatform ? { platform: metadataPinning.refreshPairedPlatform } : {}
						});
					}
				}
				const deviceToken = !trustedProxyAuthOk && device && hasServerApprovedDeviceTokenBaseline ? await ensureDeviceToken({
					deviceId: device.id,
					role,
					scopes
				}) : null;
				const bootstrapDeviceTokens = [];
				if (deviceToken) bootstrapDeviceTokens.push({
					deviceToken: deviceToken.token,
					role: deviceToken.role,
					scopes: deviceToken.scopes,
					issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs
				});
				const approvedHandoffBootstrapProfile = handoffBootstrapProfile;
				if (device && approvedHandoffBootstrapProfile) for (const bootstrapRole of approvedHandoffBootstrapProfile.roles) {
					if (bootstrapDeviceTokens.some((entry) => entry.role === bootstrapRole)) continue;
					const bootstrapRoleScopes = bootstrapRole === "operator" ? resolveBootstrapProfileScopesForRole(bootstrapRole, approvedHandoffBootstrapProfile.scopes) : [];
					const extraToken = await ensureDeviceToken({
						deviceId: device.id,
						role: bootstrapRole,
						scopes: bootstrapRoleScopes
					});
					if (!extraToken) continue;
					bootstrapDeviceTokens.push({
						deviceToken: extraToken.token,
						role: extraToken.role,
						scopes: extraToken.scopes,
						issuedAtMs: extraToken.rotatedAtMs ?? extraToken.createdAtMs
					});
				}
				if (role === "node") {
					const reconciliation = await reconcileNodePairingOnConnect({
						cfg: getRuntimeConfig(),
						connectParams,
						pairedNode: await getPairedNode(connectParams.device?.id ?? connectParams.client.id),
						reportedClientIp,
						requestPairing: async (input) => await requestNodePairing(input)
					});
					if (reconciliation.pendingPairing?.created) {
						const requestContext = buildRequestContext();
						const resolvedAt = Date.now();
						for (const superseded of reconciliation.pendingPairing.superseded ?? []) requestContext.broadcast("node.pair.resolved", {
							requestId: superseded.requestId,
							nodeId: superseded.nodeId,
							decision: "rejected",
							ts: resolvedAt
						}, { dropIfSlow: true });
						requestContext.broadcast("node.pair.requested", reconciliation.pendingPairing.request, { dropIfSlow: true });
					}
					const nodeConnectParams = connectParams;
					nodeConnectParams.declaredCaps = reconciliation.declaredCaps;
					nodeConnectParams.declaredCommands = reconciliation.declaredCommands;
					nodeConnectParams.declaredPermissions = reconciliation.declaredPermissions;
					connectParams.caps = reconciliation.effectiveCaps;
					connectParams.commands = reconciliation.effectiveCommands;
					connectParams.permissions = reconciliation.effectivePermissions;
				}
				const shouldTrackPresence = !isGatewayCliClient(connectParams.client);
				const clientId = connectParams.client.id;
				const instanceId = connectParams.client.instanceId;
				const presenceKey = shouldTrackPresence ? device?.id ?? instanceId ?? connId : void 0;
				if (isClosed()) {
					setCloseCause("connect-aborted-before-register", {
						...clientMeta,
						auth: authMethod
					});
					return;
				}
				const pluginSurfaceUrls = {};
				const pluginNodeCapabilitySurfaces = indexPluginNodeCapabilitySurfaces(pluginNodeCapabilities);
				const pendingPluginNodeCapabilities = [];
				if (pluginSurfaceBaseUrl) for (const pluginCapabilitySurface of Object.values(pluginNodeCapabilitySurfaces)) {
					const capability = mintPluginNodeCapabilityToken();
					const expiresAtMs = Date.now() + resolvePluginNodeCapabilityTtlMs(pluginCapabilitySurface);
					const scopedUrl = buildPluginNodeCapabilityScopedHostUrl(pluginSurfaceBaseUrl, capability) ?? pluginSurfaceBaseUrl;
					pluginSurfaceUrls[pluginCapabilitySurface.surface] = scopedUrl;
					pendingPluginNodeCapabilities.push({
						surface: pluginCapabilitySurface,
						capability,
						expiresAtMs
					});
				}
				const usesSharedGatewayAuth = authMethod === "token" || authMethod === "password" || authMethod === "trusted-proxy";
				const sharedGatewaySessionGeneration = usesSharedGatewayAuth ? resolveSharedGatewaySessionGeneration(resolvedAuth, trustedProxies) : void 0;
				const isTrustedApprovalRuntime = scopes.includes("operator.approvals") && connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT && connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND && isOperatorApprovalRuntimeToken(connectParams.auth?.approvalRuntimeToken);
				clearHandshakeTimer();
				const nextClient = {
					socket,
					connect: connectParams,
					connId,
					isDeviceTokenAuth: authMethod === "device-token",
					usesSharedGatewayAuth,
					sharedGatewaySessionGeneration,
					presenceKey,
					clientIp: reportedClientIp,
					...isTrustedApprovalRuntime ? { internal: { approvalRuntime: true } } : {},
					...Object.keys(pluginSurfaceUrls).length > 0 ? { pluginSurfaceUrls } : {},
					...Object.keys(pluginNodeCapabilitySurfaces).length > 0 ? { pluginNodeCapabilitySurfaces } : {}
				};
				for (const entry of pendingPluginNodeCapabilities) setClientPluginNodeCapability({
					client: nextClient,
					surface: entry.surface,
					capability: entry.capability,
					expiresAtMs: entry.expiresAtMs
				});
				setSocketMaxPayload(socket, MAX_PAYLOAD_BYTES);
				if (!setClient(nextClient)) {
					setCloseCause("connect-aborted-before-register", {
						...clientMeta,
						auth: authMethod
					});
					return;
				}
				setHandshakeState("connected");
				logWs("in", "connect", {
					connId,
					client: connectParams.client.id,
					clientDisplayName: connectParams.client.displayName,
					version: connectParams.client.version,
					mode: connectParams.client.mode,
					clientId,
					platform: connectParams.client.platform,
					auth: authMethod
				});
				if (isWebchatConnect(connectParams)) logWsControl.info(`webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`);
				if (presenceKey) {
					upsertPresence(presenceKey, {
						host: connectParams.client.displayName ?? connectParams.client.id ?? os.hostname(),
						ip: isLocalClient ? void 0 : reportedClientIp,
						version: connectParams.client.version,
						platform: connectParams.client.platform,
						deviceFamily: connectParams.client.deviceFamily,
						modelIdentifier: connectParams.client.modelIdentifier,
						mode: connectParams.client.mode,
						deviceId: device?.id,
						roles: [role],
						scopes,
						instanceId: device?.id ?? instanceId,
						reason: "connect"
					});
					incrementPresenceVersion();
				}
				if (role === "node") {
					const context = buildRequestContext();
					const nodeSession = context.nodeRegistry.register(nextClient, { remoteIp: reportedClientIp });
					const instanceIdRaw = connectParams.client.instanceId;
					const instanceId = typeof instanceIdRaw === "string" ? instanceIdRaw.trim() : "";
					const nodeIdsForPairing = new Set([nodeSession.nodeId]);
					if (instanceId) nodeIdsForPairing.add(instanceId);
					for (const nodeId of nodeIdsForPairing) updatePairedNodeMetadata(nodeId, { lastConnectedAtMs: nodeSession.connectedAtMs }).catch((err) => logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(err)}`));
					recordRemoteNodeInfo({
						nodeId: nodeSession.nodeId,
						displayName: nodeSession.displayName,
						platform: nodeSession.platform,
						deviceFamily: nodeSession.deviceFamily,
						commands: nodeSession.commands,
						remoteIp: nodeSession.remoteIp
					});
					refreshRemoteNodeBins({
						nodeId: nodeSession.nodeId,
						platform: nodeSession.platform,
						deviceFamily: nodeSession.deviceFamily,
						commands: nodeSession.commands,
						cfg: getRuntimeConfig()
					}).catch((err) => logGateway.warn(`remote bin probe failed for ${nodeSession.nodeId}: ${formatForLog(err)}`));
					loadVoiceWakeConfig().then((cfg) => {
						context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.changed", { triggers: cfg.triggers });
					}).catch((err) => logGateway.warn(`voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`));
					loadVoiceWakeRoutingConfig().then((routing) => {
						context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.routing.changed", { config: routing });
					}).catch((err) => logGateway.warn(`voicewake routing snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`));
				}
				const snapshot = buildGatewaySnapshot({ includeSensitive: scopes.includes(ADMIN_SCOPE) });
				const cachedHealth = getHealthCache();
				if (cachedHealth) {
					snapshot.health = cachedHealth;
					snapshot.stateVersion.health = getHealthVersion();
				}
				const helloOkAuthScopes = deviceToken ? deviceToken.scopes : scopes;
				const helloOk = {
					type: "hello-ok",
					protocol: 4,
					server: {
						version: resolveRuntimeServiceVersion(process.env),
						connId
					},
					features: {
						methods: gatewayMethods,
						events
					},
					snapshot,
					...Object.keys(pluginSurfaceUrls).length > 0 ? { pluginSurfaceUrls } : {},
					auth: {
						role,
						scopes: helloOkAuthScopes,
						...deviceToken ? {
							deviceToken: deviceToken.token,
							issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
							...bootstrapDeviceTokens.length > 1 ? { deviceTokens: bootstrapDeviceTokens.slice(1) } : {}
						} : {}
					},
					policy: {
						maxPayload: MAX_PAYLOAD_BYTES,
						maxBufferedBytes: MAX_BUFFERED_BYTES,
						tickIntervalMs: TICK_INTERVAL_MS
					}
				};
				let revokedBootstrapTokenRecord;
				if (authMethod === "bootstrap-token" && bootstrapTokenCandidate && device) try {
					if (handoffBootstrapProfile || issuedBootstrapProfile) {
						const redemption = await redeemDeviceBootstrapTokenProfile({
							token: bootstrapTokenCandidate,
							role,
							scopes
						});
						if (handoffBootstrapProfile || redemption.fullyRedeemed) {
							const revoked = await revokeDeviceBootstrapToken({ token: bootstrapTokenCandidate });
							if (!revoked.removed) logGateway.warn(`bootstrap token revoke skipped after profile redemption device=${device.id}`);
							else revokedBootstrapTokenRecord = revoked.record;
						}
					}
				} catch (err) {
					logGateway.warn(`bootstrap token post-connect bookkeeping failed device=${device.id}: ${formatForLog(err)}`);
				}
				try {
					await sendFrame({
						type: "res",
						id: frame.id,
						ok: true,
						payload: helloOk
					});
				} catch (err) {
					if (revokedBootstrapTokenRecord) try {
						await restoreDeviceBootstrapToken({ record: revokedBootstrapTokenRecord });
					} catch (restoreErr) {
						logGateway.warn(`bootstrap token restore after hello-send failure failed device=${device?.id ?? "unknown"}: ${formatForLog(restoreErr)}`);
					}
					setCloseCause("hello-send-failed", { error: formatForLog(err) });
					close();
					return;
				}
				logWs("out", "hello-ok", {
					connId,
					methods: gatewayMethods.length,
					events: events.length,
					presence: snapshot.presence.length,
					stateVersion: snapshot.stateVersion.presence
				});
				refreshHealthSnapshot({ probe: true }).catch((err) => logHealth.error(`post-connect health refresh failed: ${formatError(err)}`));
				return;
			}
			if (!validateRequestFrame(parsed)) {
				send({
					type: "res",
					id: parsed?.id ?? "invalid",
					ok: false,
					error: errorShape(ErrorCodes.INVALID_REQUEST, `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`)
				});
				return;
			}
			const req = parsed;
			logWs("in", "req", {
				connId,
				id: req.id,
				method: req.method
			});
			if (client.usesSharedGatewayAuth) {
				const requiredSharedGatewaySessionGeneration = getRequiredSharedGatewaySessionGeneration?.();
				if (requiredSharedGatewaySessionGeneration !== void 0 && client.sharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration) {
					setCloseCause("gateway-auth-rotated", {
						authGenerationStale: true,
						method: req.method
					});
					close(4001, "gateway auth changed");
					return;
				}
			}
			const respond = (ok, payload, error, meta) => {
				send({
					type: "res",
					id: req.id,
					ok,
					payload,
					error
				});
				const unauthorizedRoleError = isUnauthorizedRoleError(error);
				let logMeta = meta;
				if (unauthorizedRoleError) {
					const unauthorizedDecision = unauthorizedFloodGuard.registerUnauthorized();
					if (unauthorizedDecision.suppressedSinceLastLog > 0) logMeta = {
						...logMeta,
						suppressedUnauthorizedResponses: unauthorizedDecision.suppressedSinceLastLog
					};
					if (!unauthorizedDecision.shouldLog) return;
					if (unauthorizedDecision.shouldClose) {
						setCloseCause("repeated-unauthorized-requests", {
							unauthorizedCount: unauthorizedDecision.count,
							method: req.method
						});
						queueMicrotask(() => close(1008, "repeated unauthorized calls"));
					}
					logMeta = {
						...logMeta,
						unauthorizedCount: unauthorizedDecision.count
					};
				} else unauthorizedFloodGuard.reset();
				logWs("out", "res", {
					connId,
					id: req.id,
					ok,
					method: req.method,
					errorCode: error?.code,
					errorMessage: error?.message,
					...logMeta
				});
			};
			(async () => {
				const { handleGatewayRequest } = await import("./server-methods-90LGtoqF.js");
				await handleGatewayRequest({
					req,
					respond,
					client,
					isWebchatConnect,
					extraHandlers,
					methodRegistry: getMethodRegistry?.(),
					context: buildRequestContext()
				});
			})().catch((err) => {
				logGateway.error(`request handler failed: ${formatForLog(err)}`);
				respond(false, void 0, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
			});
		} catch (err) {
			logGateway.error(`parse/handle error: ${String(err)}`);
			logWs("out", "parse-error", {
				connId,
				error: formatForLog(err)
			});
			if (!getClient()) close();
		}
	};
	socket.on("message", (data) => {
		runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () => handleMessage(data));
	});
}
function getRawDataByteLength(data) {
	if (Buffer.isBuffer(data)) return data.byteLength;
	if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.byteLength, 0);
	if (data instanceof ArrayBuffer) return data.byteLength;
	return Buffer.byteLength(String(data));
}
function setSocketMaxPayload(socket, maxPayload) {
	const receiver = socket["_receiver"];
	if (receiver) receiver["_maxPayload"] = maxPayload;
}
//#endregion
export { attachGatewayWsMessageHandler };
