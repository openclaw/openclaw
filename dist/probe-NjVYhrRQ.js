import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
//#region src/cli/daemon-cli/probe.ts
const probeGatewayModuleLoader = createLazyImportLoader(() => import("./probe-CnwEPT5D.js"));
async function loadProbeGatewayModule() {
	return await probeGatewayModuleLoader.load();
}
function resolveProbeFailureMessage(result) {
	const closeHint = result.close ? `gateway closed (${result.close.code}): ${result.close.reason}` : null;
	if (closeHint && (!result.error || result.error === "timeout")) return closeHint;
	return result.error ?? closeHint ?? "gateway probe failed";
}
function resolveGatewayStatusProbeDetails(result) {
	return "authProbe" in result ? result.authProbe : result;
}
function readRuntimeVersionFromStatusPayload(payload) {
	if (!payload || typeof payload !== "object") return null;
	const runtimeVersion = payload.runtimeVersion;
	return typeof runtimeVersion === "string" && runtimeVersion.trim().length > 0 ? runtimeVersion.trim() : null;
}
async function probeGatewayStatus(opts) {
	const kind = opts.requireRpc ? "read" : "connect";
	try {
		let statusRuntimeVersion = null;
		const result = await withProgress({
			label: "Checking gateway status...",
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => {
			const { probeGateway } = await loadProbeGatewayModule();
			const probeOpts = {
				url: opts.url,
				auth: {
					token: opts.token,
					password: opts.password
				},
				tlsFingerprint: opts.tlsFingerprint,
				...opts.preauthHandshakeTimeoutMs !== void 0 ? { preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs } : {},
				timeoutMs: opts.timeoutMs,
				includeDetails: false
			};
			if (opts.requireRpc) {
				const { callGateway } = await import("./call-C8FPOqHS.js");
				statusRuntimeVersion = readRuntimeVersionFromStatusPayload(await callGateway({
					url: opts.url,
					token: opts.token,
					password: opts.password,
					tlsFingerprint: opts.tlsFingerprint,
					...opts.config ? { config: opts.config } : {},
					method: "status",
					timeoutMs: opts.timeoutMs,
					...opts.configPath ? { configPath: opts.configPath } : {}
				}));
				return {
					ok: true,
					authProbe: await probeGateway(probeOpts).catch(() => null)
				};
			}
			return await probeGateway(probeOpts);
		});
		const probeDetails = resolveGatewayStatusProbeDetails(result);
		const auth = probeDetails?.auth;
		const server = probeDetails?.server;
		const serverSummary = server ? { server } : {};
		const version = server?.version ?? ("authProbe" in result ? statusRuntimeVersion : null);
		if (result.ok) return {
			ok: true,
			kind,
			capability: kind === "read" ? auth?.capability && auth.capability !== "unknown" ? auth.capability : "read_only" : auth?.capability,
			auth,
			...serverSummary,
			...version != null ? { version } : {}
		};
		return {
			ok: false,
			kind,
			capability: auth?.capability,
			auth,
			...serverSummary,
			...version != null ? { version } : {},
			error: resolveProbeFailureMessage(result)
		};
	} catch (err) {
		return {
			ok: false,
			kind,
			error: formatErrorMessage(err)
		};
	}
}
//#endregion
export { probeGatewayStatus };
