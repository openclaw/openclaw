import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as sanitizeForLog } from "./ansi-Bk0Jp_0O.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { i as isLoopbackHost } from "./net-Gkm1Cz9b.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-CgOISqZp.js";
import { n as normalizeDeviceAuthScopes } from "./device-auth-Cm0WAJ4e.js";
import { d as readConnectPairingRequiredMessage } from "./connect-error-details-Coy_cvEz.js";
import { r as PAIRING_SCOPE, t as ADMIN_SCOPE } from "./operator-scopes-CpnZaPqz.js";
import "./method-scopes-CQOTpXrQ.js";
import { i as callGateway, r as buildGatewayConnectionDetails } from "./call-DO7ujqcl.js";
import { n as formatTimeAgo } from "./format-relative-ByQTDMWR.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
import { g as summarizeDeviceTokens, i as formatDevicePairingForbiddenMessage, l as listDevicePairing, n as approveDevicePairing } from "./device-pairing-jhsMNs7J.js";
import { t as applyParentDefaultHelpAction } from "./parent-default-help-DtmmvIIp.js";
import { n as renderTable, t as getTerminalTableWidth } from "./table-BsNNo8cs.js";
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
//#region src/cli/devices-cli.ts
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
const devicesCallOpts = (cmd, defaults) => cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (password auth)").option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? DEFAULT_DEVICES_TIMEOUT_MS)).option("--json", "Output JSON", false);
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
	const scopes = await resolveApprovePairingGatewayScopes(opts, requestId);
	try {
		return await callGatewayCli("device.pair.approve", opts, { requestId }, scopes ? { scopes } : void 0);
	} catch (error) {
		if (isDevicePairingApprovalDenied(error) && !scopes?.includes("operator.admin")) return await callGatewayCli("device.pair.approve", opts, { requestId }, { scopes: [ADMIN_SCOPE] });
		const fallback = resolveLocalPairingFallback(opts, error);
		if (!fallback) throw error;
		const gatewayRequestId = normalizeOptionalString(fallback.details.requestId);
		if (gatewayRequestId && gatewayRequestId !== requestId) throw buildFallbackStateMismatchError(fallback.details);
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
async function resolveApprovePairingGatewayScopes(opts, requestId) {
	try {
		const list = await listPairingWithFallback(opts);
		const request = list.pending?.find((pending) => pending.requestId === requestId);
		if (!request) return;
		return resolveApprovePairingScopesForRequest(request, lookupPairedDevice(indexPairedDevices(list.paired), request));
	} catch {
		return;
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
function registerDevicesCli(program) {
	const devices = program.command("devices").description("Device pairing and auth tokens");
	devicesCallOpts(devices.command("list").description("List pending and paired devices").action(async (opts) => {
		const list = await listPairingWithFallback(opts);
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
	}));
	devicesCallOpts(devices.command("remove").description("Remove a paired device entry").argument("<deviceId>", "Paired device id").action(async (deviceId, opts) => {
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
	}));
	devicesCallOpts(devices.command("clear").description("Clear paired devices from the gateway table").option("--pending", "Also reject all pending pairing requests", false).option("--yes", "Confirm destructive clear", false).action(async (opts) => {
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
	}));
	devicesCallOpts(devices.command("approve").description("Approve a pending device pairing request").argument("[requestId]", "Pending request id").option("--latest", "Show the most recent pending request to approve explicitly", false).action(async (requestId, opts) => {
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
		const deviceId = result?.device?.deviceId;
		defaultRuntime.log(`${theme.success("Approved")} ${theme.command(deviceId ?? "ok")} ${theme.muted(`(${resolvedRequestId})`)}`);
	}));
	devicesCallOpts(devices.command("reject").description("Reject a pending device pairing request").argument("<requestId>", "Pending request id").action(async (requestId, opts) => {
		const result = await callGatewayCli("device.pair.reject", opts, { requestId });
		if (opts.json) {
			defaultRuntime.writeJson(result);
			return;
		}
		const deviceId = result?.deviceId;
		defaultRuntime.log(`${theme.warn("Rejected")} ${theme.command(deviceId ?? "ok")}`);
	}));
	devicesCallOpts(devices.command("rotate").description("Rotate a device token for a role").requiredOption("--device <id>", "Device id").requiredOption("--role <role>", "Role name").option("--scope <scope...>", "Scopes to attach to the token (repeatable)").action(async (opts) => {
		const required = resolveRequiredDeviceRole(opts);
		if (!required) return;
		const result = await callGatewayCli("device.token.rotate", opts, {
			deviceId: required.deviceId,
			role: required.role,
			scopes: Array.isArray(opts.scope) ? opts.scope : void 0
		});
		defaultRuntime.writeJson(result);
	}));
	devicesCallOpts(devices.command("revoke").description("Revoke a device token for a role").requiredOption("--device <id>", "Device id").requiredOption("--role <role>", "Role name").action(async (opts) => {
		const required = resolveRequiredDeviceRole(opts);
		if (!required) return;
		const result = await callGatewayCli("device.token.revoke", opts, {
			deviceId: required.deviceId,
			role: required.role
		});
		defaultRuntime.writeJson(result);
	}));
	applyParentDefaultHelpAction(devices);
}
//#endregion
export { registerDevicesCli };
