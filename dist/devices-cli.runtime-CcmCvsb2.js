import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { n as normalizeDeviceAuthScopes } from "./device-auth-CLuEWAWX.js";
import { d as readConnectPairingRequiredMessage } from "./connect-error-details-BNpp20bs.js";
import { r as PAIRING_SCOPE, t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import "./method-scopes-D4RcH8qD.js";
import { c as formatGatewayTransportErrorJson, n as buildGatewayConnectionDetails, r as callGateway } from "./call-t1U2G3yY.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { g as summarizeDeviceTokens, i as formatDevicePairingForbiddenMessage, l as listDevicePairing, n as approveDevicePairing } from "./device-pairing-C3feAqgm.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-ockhvL7y.js";
//#region src/shared/device-pairing-access.ts
function normalizeRoleList(...items) {
	const roles = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (!item) continue;
		if (Array.isArray(item)) {
			for (const role of item) {
				const trimmed = role.trim();
				if (trimmed) roles.add(trimmed);
			}
			continue;
		}
		const trimmed = item.trim();
		if (trimmed) roles.add(trimmed);
	}
	return [...roles].toSorted();
}
function includesAll(allowed, requested) {
	const allowedSet = new Set(allowed);
	return requested.every((value) => allowedSet.has(value));
}
function summarizePendingDeviceAccess(request) {
	return {
		roles: normalizeRoleList(request.roles, request.role),
		scopes: normalizeDeviceAuthScopes(request.scopes)
	};
}
function summarizeApprovedDeviceAccess(device) {
	const approvedRoles = normalizeRoleList(device.roles, device.role);
	const tokenList = Array.isArray(device.tokens) ? device.tokens : device.tokens ? Object.values(device.tokens) : void 0;
	return {
		roles: tokenList === void 0 ? approvedRoles : normalizeRoleList(tokenList.filter((token) => !token.revokedAtMs).flatMap((token) => token.role ?? [])).filter((role) => approvedRoles.includes(role)),
		scopes: normalizeDeviceAuthScopes(device.scopes)
	};
}
function resolvePendingDeviceApprovalState(request, paired) {
	const requested = summarizePendingDeviceAccess(request);
	const approved = paired ? summarizeApprovedDeviceAccess(paired) : null;
	if (!approved) return {
		kind: "new-pairing",
		requested,
		approved: null
	};
	if (!includesAll(approved.roles, requested.roles)) return {
		kind: "role-upgrade",
		requested,
		approved
	};
	if (!includesAll(approved.scopes, requested.scopes)) return {
		kind: "scope-upgrade",
		requested,
		approved
	};
	return {
		kind: "re-approval",
		requested,
		approved
	};
}
//#endregion
//#region src/cli/devices-cli.runtime.ts
const FALLBACK_NOTICE = "Direct scope access failed; using local fallback.";
const DEFAULT_DEVICES_TIMEOUT_MS = 1e4;
const FALLBACK_STATE_MISMATCH_MESSAGE = "Gateway requires device pairing, but local fallback pairing state does not contain the gateway request.";
const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPE_PREFIX = "operator.";
const KNOWN_NON_ADMIN_OPERATOR_SCOPES = new Set([
	"operator.approvals",
	"operator.pairing",
	"operator.read",
	"operator.talk.secrets",
	"operator.write"
]);
const callGatewayCli = async (method, opts, params, callOpts) => withProgress({
	label: `Devices ${method}`,
	indeterminate: true,
	enabled: opts.json !== true
}, async () => await callGateway({
	url: opts.url,
	token: opts.token,
	password: opts.password,
	method,
	params,
	timeoutMs: Number(opts.timeout ?? DEFAULT_DEVICES_TIMEOUT_MS),
	clientName: GATEWAY_CLIENT_NAMES.CLI,
	mode: GATEWAY_CLIENT_MODES.CLI,
	scopes: callOpts?.scopes
}));
function normalizeErrorMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
function isDevicePairingApprovalDenied(error) {
	return normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error)).includes("device pairing approval denied");
}
function resolveLocalPairingFallback(opts, error) {
	const details = readConnectPairingRequiredMessage(normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error)));
	if (!details) return null;
	if (typeof opts.url === "string" && opts.url.trim().length > 0) return null;
	const connection = buildGatewayConnectionDetails();
	if (connection.urlSource !== "local loopback") return null;
	try {
		return isLoopbackHost(new URL(connection.url).hostname) ? { details } : null;
	} catch {
		return null;
	}
}
function buildFallbackStateMismatchError(details) {
	return new Error([
		details.requestId ? `${FALLBACK_STATE_MISMATCH_MESSAGE} Missing requestId: ${details.requestId}.` : FALLBACK_STATE_MISMATCH_MESSAGE,
		"The running gateway is probably using a different OPENCLAW_PROFILE or OPENCLAW_STATE_DIR than this CLI.",
		"Rerun with the same profile/state-dir as the gateway, or pass --token/--password so the CLI can approve through the gateway."
	].join("\n"));
}
function assertLocalFallbackMatchesGatewayRequest(details, list) {
	const requestId = normalizeOptionalString(details.requestId);
	if (!requestId) return;
	if (!(list.pending ?? []).some((request) => normalizeOptionalString(request.requestId) === requestId)) throw buildFallbackStateMismatchError(details);
}
function redactLocalPairedDevice(device) {
	const { tokens, ...rest } = device;
	return {
		...rest,
		tokens: summarizeDeviceTokens(tokens)
	};
}
async function listPairingWithFallback(opts) {
	try {
		return parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
	} catch (error) {
		const fallback = resolveLocalPairingFallback(opts, error);
		if (!fallback) throw error;
		const local = await listDevicePairing();
		const list = {
			pending: local.pending,
			paired: local.paired.map((device) => redactLocalPairedDevice(device))
		};
		assertLocalFallbackMatchesGatewayRequest(fallback.details, list);
		if (opts.json !== true) defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
		return list;
	}
}
async function approvePairingWithFallback(opts, requestId) {
	const { scopes, originalRequest } = await resolveApprovePairingGatewayContext(opts, requestId);
	try {
		return await callGatewayCli("device.pair.approve", opts, { requestId }, scopes ? { scopes } : void 0);
	} catch (error) {
		if (isDevicePairingApprovalDenied(error) && !scopes?.includes("operator.admin")) return await callGatewayCli("device.pair.approve", opts, { requestId }, { scopes: [ADMIN_SCOPE] });
		const fallback = resolveLocalPairingFallback(opts, error);
		if (!fallback) throw error;
		const gatewayRequestId = normalizeOptionalString(fallback.details.requestId);
		if (gatewayRequestId && gatewayRequestId !== requestId) {
			const local = await listDevicePairing();
			const localList = {
				pending: local.pending,
				paired: local.paired.map((device) => redactLocalPairedDevice(device))
			};
			const replacement = findSameDeviceReplacementRequest({
				originalRequest,
				originalRequestId: requestId,
				gatewayRequestId,
				pending: localList.pending,
				paired: localList.paired
			});
			if (replacement) {
				const approved = await approveDevicePairing(replacement.requestId, { callerScopes: ["operator.admin"] });
				if (!approved) return null;
				if (approved.status === "forbidden") throw new Error(formatDevicePairingForbiddenMessage(approved), { cause: error });
				if (opts.json !== true) {
					defaultRuntime.log(theme.warn(`Pending request ${sanitizeForLog(requestId)} was replaced by same-device repair ${sanitizeForLog(replacement.requestId)}; approving latest compatible request.`));
					defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
				}
				return {
					requestId: replacement.requestId,
					resolved: {
						kind: "same-device-replacement",
						requestedRequestId: requestId,
						approvedRequestId: replacement.requestId
					},
					device: redactLocalPairedDevice(approved.device)
				};
			}
			const hasOriginalPending = Boolean(findPendingRequestById(localList.pending, requestId));
			const hasGatewayPending = Boolean(findPendingRequestById(localList.pending, gatewayRequestId));
			if (!hasOriginalPending && !hasGatewayPending) return null;
			throw buildFallbackStateMismatchError(fallback.details);
		}
		const approved = await approveDevicePairing(requestId, { callerScopes: ["operator.admin"] });
		if (!approved) {
			if (gatewayRequestId && gatewayRequestId === requestId) throw buildFallbackStateMismatchError(fallback.details);
			return null;
		}
		if (approved.status === "forbidden") throw new Error(formatDevicePairingForbiddenMessage(approved), { cause: error });
		if (opts.json !== true) defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
		return {
			requestId,
			device: redactLocalPairedDevice(approved.device)
		};
	}
}
function parseDevicePairingList(value) {
	const obj = typeof value === "object" && value !== null ? value : {};
	return {
		pending: Array.isArray(obj.pending) ? obj.pending : [],
		paired: Array.isArray(obj.paired) ? obj.paired : []
	};
}
function normalizeDeviceRoles(request) {
	const roles = /* @__PURE__ */ new Set();
	for (const role of request.roles ?? []) {
		const normalized = normalizeOptionalString(role);
		if (normalized) roles.add(normalized);
	}
	const role = normalizeOptionalString(request.role);
	if (role) roles.add(role);
	return [...roles];
}
function normalizeOperatorScopes(scopes) {
	return normalizeDeviceAuthScopes(scopes).filter((scope) => scope.startsWith(OPERATOR_SCOPE_PREFIX));
}
function findPendingRequestById(pending, requestId) {
	const normalizedRequestId = normalizeOptionalString(requestId);
	if (!normalizedRequestId) return null;
	return pending?.find((request) => normalizeOptionalString(request.requestId) === normalizedRequestId) ?? null;
}
function hasExactRoleMatch(original, replacement) {
	const originalRoles = normalizeDeviceRoles(original);
	const replacementRoles = normalizeDeviceRoles(replacement);
	if (originalRoles.length !== replacementRoles.length) return false;
	const replacementRoleSet = new Set(replacementRoles);
	return originalRoles.every((role) => replacementRoleSet.has(role));
}
function hasCompatibleClientMetadata(original, replacement) {
	const originalClientId = normalizeOptionalString(original.clientId);
	const replacementClientId = normalizeOptionalString(replacement.clientId);
	if (originalClientId && replacementClientId && originalClientId !== replacementClientId) return false;
	const originalClientMode = normalizeOptionalString(original.clientMode);
	const replacementClientMode = normalizeOptionalString(replacement.clientMode);
	return !(originalClientMode && replacementClientMode && originalClientMode !== replacementClientMode);
}
function resolveOriginalReplacementScopes(original, paired) {
	const requestedScopes = normalizeDeviceAuthScopes(original.scopes);
	const inferredOperatorScopes = resolvePendingOperatorApprovalScopes(original, paired);
	return [...new Set([...requestedScopes, ...inferredOperatorScopes])];
}
function replacementScopesCoverOriginal(original, replacement, paired) {
	const originalScopes = resolveOriginalReplacementScopes(original, paired);
	const replacementScopes = normalizeDeviceAuthScopes(replacement.scopes);
	const replacementScopeSet = new Set(replacementScopes);
	if (!originalScopes.every((scope) => replacementScopeSet.has(scope))) return false;
	return replacementScopes.every((scope) => originalScopes.includes(scope) || scope === "operator.pairing");
}
function findSameDeviceReplacementRequest(params) {
	const originalRequestId = normalizeOptionalString(params.originalRequestId);
	if (!params.originalRequest || !originalRequestId) return null;
	if (normalizeOptionalString(params.originalRequest.requestId) !== originalRequestId) return null;
	const replacement = findPendingRequestById(params.pending, params.gatewayRequestId);
	if (!replacement) return null;
	const originalDeviceId = normalizeOptionalString(params.originalRequest.deviceId);
	const replacementDeviceId = normalizeOptionalString(replacement.deviceId);
	if (!originalDeviceId || originalDeviceId !== replacementDeviceId) return null;
	const originalPublicKey = normalizeOptionalString(params.originalRequest.publicKey);
	const replacementPublicKey = normalizeOptionalString(replacement.publicKey);
	if (!originalPublicKey || !replacementPublicKey || originalPublicKey !== replacementPublicKey) return null;
	if (!hasExactRoleMatch(params.originalRequest, replacement)) return null;
	if (!hasCompatibleClientMetadata(params.originalRequest, replacement)) return null;
	const pairedByDeviceId = indexPairedDevices(params.paired);
	const originalPaired = lookupPairedDevice(pairedByDeviceId, params.originalRequest);
	const replacementPaired = lookupPairedDevice(pairedByDeviceId, replacement);
	if (!replacementScopesCoverOriginal(params.originalRequest, replacement, originalPaired)) return null;
	if (replacement.isRepair !== true && (!originalPaired || !replacementPaired)) return null;
	return replacement;
}
function resolvePairedOperatorScopes(paired) {
	const operatorToken = paired?.tokens?.find((token) => {
		return normalizeOptionalString(token.role) === OPERATOR_ROLE && !token.revokedAtMs;
	});
	return normalizeOperatorScopes(operatorToken?.scopes ?? paired?.scopes);
}
function resolvePendingOperatorApprovalScopes(request, paired) {
	if (!normalizeDeviceRoles(request).includes(OPERATOR_ROLE)) return [];
	const requestedScopes = normalizeOperatorScopes(request.scopes);
	return requestedScopes.length > 0 ? requestedScopes : resolvePairedOperatorScopes(paired);
}
function isKnownNonAdminOperatorScope(scope) {
	return KNOWN_NON_ADMIN_OPERATOR_SCOPES.has(scope);
}
function resolveApprovePairingScopesForRequest(request, paired) {
	const operatorScopes = resolvePendingOperatorApprovalScopes(request, paired);
	if (operatorScopes.length === 0) return;
	if (operatorScopes.includes("operator.admin")) return [ADMIN_SCOPE];
	const out = new Set([PAIRING_SCOPE]);
	for (const scope of operatorScopes) {
		if (!isKnownNonAdminOperatorScope(scope)) return [ADMIN_SCOPE];
		out.add(scope);
	}
	return [...out];
}
async function resolveApprovePairingGatewayContext(opts, requestId) {
	try {
		const list = await listPairingWithFallback(opts);
		const request = findPendingRequestById(list.pending, requestId);
		if (!request) return {
			originalRequest: null,
			scopes: void 0
		};
		return {
			originalRequest: request,
			scopes: resolveApprovePairingScopesForRequest(request, lookupPairedDevice(indexPairedDevices(list.paired), request))
		};
	} catch {
		return {
			originalRequest: null,
			scopes: void 0
		};
	}
}
function selectLatestPendingRequest(pending) {
	if (!pending?.length) return null;
	return pending.reduce((latest, current) => {
		const latestTs = typeof latest.ts === "number" ? latest.ts : 0;
		return (typeof current.ts === "number" ? current.ts : 0) > latestTs ? current : latest;
	});
}
function formatTokenSummary(tokens) {
	if (!tokens || tokens.length === 0) return "none";
	return tokens.map((t) => `${sanitizeForLog(t.role)}${t.revokedAtMs ? " (revoked)" : ""}`).toSorted((a, b) => a.localeCompare(b)).join(", ");
}
function formatPendingDeviceIdentity(request) {
	const displayName = normalizeOptionalString(request.displayName);
	if (displayName) return sanitizeForLog(displayName);
	return sanitizeForLog(normalizeOptionalString(request.deviceId) ?? "");
}
function formatAccessSummary(access) {
	if (!access) return "none";
	return `roles: ${access.roles.length > 0 ? access.roles.map((role) => sanitizeForLog(role)).join(", ") : "none"}; scopes: ${access.scopes.length > 0 ? access.scopes.map((scope) => sanitizeForLog(scope)).join(", ") : "none"}`;
}
function formatPendingApprovalKind(kind) {
	switch (kind) {
		case "new-pairing": return "new pairing";
		case "role-upgrade": return "role upgrade";
		case "scope-upgrade": return "scope upgrade";
		case "re-approval": return "re-approval";
	}
	throw new Error("unsupported pending approval kind");
}
function indexPairedDevices(paired) {
	const out = /* @__PURE__ */ new Map();
	for (const device of paired ?? []) {
		const deviceId = normalizeOptionalString(device.deviceId);
		if (deviceId) out.set(deviceId, device);
	}
	return out;
}
function lookupPairedDevice(pairedByDeviceId, request) {
	const normalizedDeviceId = normalizeOptionalString(request.deviceId);
	if (!normalizedDeviceId) return;
	const paired = pairedByDeviceId.get(normalizedDeviceId);
	if (!paired) return;
	const requestPublicKey = normalizeOptionalString(request.publicKey);
	const pairedPublicKey = normalizeOptionalString(paired.publicKey);
	if (requestPublicKey && pairedPublicKey && requestPublicKey !== pairedPublicKey) return;
	return paired;
}
function quoteCliArg(value) {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function buildExplicitApproveCommand(opts, requestId) {
	const args = [
		"openclaw",
		"devices",
		"approve",
		requestId
	];
	const url = normalizeOptionalString(opts.url);
	if (url) args.push("--url", url);
	const timeout = normalizeOptionalString(opts.timeout);
	if (timeout && timeout !== String(DEFAULT_DEVICES_TIMEOUT_MS)) args.push("--timeout", timeout);
	if (opts.json === true) args.push("--json");
	return args.map(quoteCliArg).join(" ");
}
function formatAuthFlagReminder(opts) {
	const flags = [];
	if (normalizeOptionalString(opts.token)) flags.push("--token");
	if (normalizeOptionalString(opts.password)) flags.push("--password");
	if (flags.length === 0) return "";
	return `Reuse the same ${flags.join("/")} option${flags.length === 1 ? "" : "s"} when rerunning.`;
}
function resolveRequiredDeviceRole(opts) {
	const deviceId = normalizeStringifiedOptionalString(opts.device) ?? "";
	const role = normalizeStringifiedOptionalString(opts.role) ?? "";
	if (deviceId && role) return {
		deviceId,
		role
	};
	defaultRuntime.error(`--device and --role are required. Run ${formatCliCommand("openclaw devices list")} to choose a paired device.`);
	defaultRuntime.exit(1);
	return null;
}
async function runDevicesListCommand(opts) {
	let list;
	try {
		list = await listPairingWithFallback(opts);
	} catch (error) {
		if (opts.json) {
			const payload = formatGatewayTransportErrorJson(error);
			if (payload) {
				defaultRuntime.writeJson(payload);
				defaultRuntime.exit(1);
				return;
			}
		}
		throw error;
	}
	const pairedByDeviceId = indexPairedDevices(list.paired);
	if (opts.json) {
		defaultRuntime.writeJson(list);
		return;
	}
	if (list.pending?.length) {
		const tableWidth = getTerminalTableWidth();
		defaultRuntime.log(`${theme.heading("Pending")} ${theme.muted(`(${list.pending.length})`)}`);
		defaultRuntime.log(renderTable({
			width: tableWidth,
			columns: [
				{
					key: "Request",
					header: "Request",
					minWidth: 10
				},
				{
					key: "Device",
					header: "Device",
					minWidth: 16,
					flex: true
				},
				{
					key: "Requested",
					header: "Requested",
					minWidth: 20,
					flex: true
				},
				{
					key: "Approved",
					header: "Approved",
					minWidth: 20,
					flex: true
				},
				{
					key: "Age",
					header: "Age",
					minWidth: 8
				},
				{
					key: "Status",
					header: "Status",
					minWidth: 12
				}
			],
			rows: list.pending.map((req) => {
				const approval = resolvePendingDeviceApprovalState(req, lookupPairedDevice(pairedByDeviceId, req));
				const statusParts = [formatPendingApprovalKind(approval.kind)];
				if (req.isRepair) statusParts.push("repair");
				return {
					Request: req.requestId,
					Device: `${formatPendingDeviceIdentity(req)}${req.remoteIp ? ` · ${sanitizeForLog(req.remoteIp)}` : ""}`,
					Requested: formatAccessSummary(approval.requested),
					Approved: formatAccessSummary(approval.approved),
					Age: typeof req.ts === "number" ? formatTimeAgo(Date.now() - req.ts) : "",
					Status: statusParts.join(", ")
				};
			})
		}).trimEnd());
	}
	if (list.paired?.length) {
		const tableWidth = getTerminalTableWidth();
		defaultRuntime.log(`${theme.heading("Paired")} ${theme.muted(`(${list.paired.length})`)}`);
		defaultRuntime.log(renderTable({
			width: tableWidth,
			columns: [
				{
					key: "Device",
					header: "Device",
					minWidth: 16,
					flex: true
				},
				{
					key: "Roles",
					header: "Roles",
					minWidth: 12,
					flex: true
				},
				{
					key: "Scopes",
					header: "Scopes",
					minWidth: 12,
					flex: true
				},
				{
					key: "Tokens",
					header: "Tokens",
					minWidth: 12,
					flex: true
				},
				{
					key: "IP",
					header: "IP",
					minWidth: 12
				}
			],
			rows: list.paired.map((device) => ({
				Device: sanitizeForLog(device.displayName || device.deviceId),
				Roles: device.roles?.length ? device.roles.map((role) => sanitizeForLog(role)).join(", ") : "",
				Scopes: device.scopes?.length ? device.scopes.map((scope) => sanitizeForLog(scope)).join(", ") : "",
				Tokens: formatTokenSummary(device.tokens),
				IP: device.remoteIp ? sanitizeForLog(device.remoteIp) : ""
			}))
		}).trimEnd());
	}
	if (!list.pending?.length && !list.paired?.length) defaultRuntime.log(theme.muted("No device pairing entries."));
}
async function runDevicesRemoveCommand(deviceId, opts) {
	const trimmed = deviceId.trim();
	if (!trimmed) {
		defaultRuntime.error(`deviceId is required. Run ${formatCliCommand("openclaw devices list")} to choose a paired device.`);
		defaultRuntime.exit(1);
		return;
	}
	const result = await callGatewayCli("device.pair.remove", opts, { deviceId: trimmed });
	if (opts.json) {
		defaultRuntime.writeJson(result);
		return;
	}
	defaultRuntime.log(`${theme.warn("Removed")} ${theme.command(trimmed)}`);
}
async function runDevicesClearCommand(opts) {
	if (!opts.yes) {
		defaultRuntime.error("Refusing to clear pairing table without --yes");
		defaultRuntime.exit(1);
		return;
	}
	const list = parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
	const removedDeviceIds = [];
	const rejectedRequestIds = [];
	const paired = Array.isArray(list.paired) ? list.paired : [];
	for (const device of paired) {
		const deviceId = normalizeOptionalString(device.deviceId) ?? "";
		if (!deviceId) continue;
		await callGatewayCli("device.pair.remove", opts, { deviceId });
		removedDeviceIds.push(deviceId);
	}
	if (opts.pending) {
		const pending = Array.isArray(list.pending) ? list.pending : [];
		for (const req of pending) {
			const requestId = normalizeOptionalString(req.requestId) ?? "";
			if (!requestId) continue;
			await callGatewayCli("device.pair.reject", opts, { requestId });
			rejectedRequestIds.push(requestId);
		}
	}
	if (opts.json) {
		defaultRuntime.writeJson({
			removedDevices: removedDeviceIds,
			rejectedPending: rejectedRequestIds
		});
		return;
	}
	defaultRuntime.log(`${theme.warn("Cleared")} ${removedDeviceIds.length} paired device${removedDeviceIds.length === 1 ? "" : "s"}`);
	if (opts.pending) defaultRuntime.log(`${theme.warn("Rejected")} ${rejectedRequestIds.length} pending request${rejectedRequestIds.length === 1 ? "" : "s"}`);
}
async function runDevicesApproveCommand(requestId, opts) {
	let pairingList = null;
	let resolvedRequestId = requestId?.trim();
	const usingImplicitSelection = !resolvedRequestId || Boolean(opts.latest);
	let selectedRequest = null;
	if (usingImplicitSelection) {
		pairingList = await listPairingWithFallback(opts);
		selectedRequest = selectLatestPendingRequest(pairingList.pending);
		resolvedRequestId = selectedRequest?.requestId?.trim();
	}
	if (!resolvedRequestId) {
		defaultRuntime.error("No pending device pairing requests to approve");
		defaultRuntime.exit(1);
		return;
	}
	if (usingImplicitSelection) {
		const req = selectedRequest;
		const approval = resolvePendingDeviceApprovalState(req, lookupPairedDevice(indexPairedDevices(pairingList?.paired), req));
		const approveCommand = buildExplicitApproveCommand(opts, req.requestId);
		const authReminder = formatAuthFlagReminder(opts);
		if (opts.json) {
			defaultRuntime.writeJson({
				selected: req,
				approvalState: {
					kind: approval.kind,
					requested: approval.requested,
					approved: approval.approved
				},
				approveCommand,
				requiresAuthFlags: {
					token: Boolean(normalizeOptionalString(opts.token)),
					password: Boolean(normalizeOptionalString(opts.password))
				}
			});
			defaultRuntime.exit(1);
			return;
		}
		defaultRuntime.log(`${theme.warn("Selected pending device request")} ${theme.command(req.requestId)}`);
		defaultRuntime.log(`  Device: ${formatPendingDeviceIdentity(req)}`);
		defaultRuntime.log(`  Requested: ${formatAccessSummary(approval.requested)}`);
		if (approval.approved) defaultRuntime.log(`  Approved: ${formatAccessSummary(approval.approved)}`);
		if (req.remoteIp) defaultRuntime.log(`  IP:     ${sanitizeForLog(req.remoteIp)}`);
		switch (approval.kind) {
			case "scope-upgrade":
				defaultRuntime.log("  Note:   Already paired. Requested scopes exceed the current approval, so reconnect stays blocked until you approve this upgrade.");
				break;
			case "role-upgrade":
				defaultRuntime.log("  Note:   Already paired. Requested role exceeds the current approval, so reconnect stays blocked until you approve this upgrade.");
				break;
			case "re-approval":
				defaultRuntime.log("  Note:   Already paired. Approval-bound device details changed, so OpenClaw created a fresh request instead of silently reusing the old approval.");
				break;
			case "new-pairing":
				defaultRuntime.log("  Note:   First-time device pairing request.");
				break;
		}
		defaultRuntime.error(`Approve this exact request with: ${approveCommand}`);
		if (authReminder) defaultRuntime.error(authReminder);
		defaultRuntime.exit(1);
		return;
	}
	const result = await approvePairingWithFallback(opts, resolvedRequestId);
	if (!result) {
		defaultRuntime.error("unknown requestId");
		defaultRuntime.exit(1);
		return;
	}
	if (opts.json) {
		defaultRuntime.writeJson(result);
		return;
	}
	const resultRequestId = result?.requestId;
	const approvedRequestId = typeof resultRequestId === "string" && resultRequestId.trim().length > 0 ? resultRequestId : resolvedRequestId;
	const deviceId = result?.device?.deviceId;
	defaultRuntime.log(`${theme.success("Approved")} ${theme.command(deviceId ?? "ok")} ${theme.muted(`(${approvedRequestId})`)}`);
}
async function runDevicesRejectCommand(requestId, opts) {
	const result = await callGatewayCli("device.pair.reject", opts, { requestId });
	if (opts.json) {
		defaultRuntime.writeJson(result);
		return;
	}
	const deviceId = result?.deviceId;
	defaultRuntime.log(`${theme.warn("Rejected")} ${theme.command(deviceId ?? "ok")}`);
}
async function runDevicesRotateCommand(opts) {
	const required = resolveRequiredDeviceRole(opts);
	if (!required) return;
	const result = await callGatewayCli("device.token.rotate", opts, {
		deviceId: required.deviceId,
		role: required.role,
		scopes: Array.isArray(opts.scope) ? opts.scope : void 0
	});
	defaultRuntime.writeJson(result);
}
async function runDevicesRevokeCommand(opts) {
	const required = resolveRequiredDeviceRole(opts);
	if (!required) return;
	const result = await callGatewayCli("device.token.revoke", opts, {
		deviceId: required.deviceId,
		role: required.role
	});
	defaultRuntime.writeJson(result);
}
//#endregion
export { runDevicesApproveCommand, runDevicesClearCommand, runDevicesListCommand, runDevicesRejectCommand, runDevicesRemoveCommand, runDevicesRevokeCommand, runDevicesRotateCommand };
