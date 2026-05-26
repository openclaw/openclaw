import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
//#region src/cli/daemon-cli/probe.ts
const probeGatewayModuleLoader = createLazyImportLoader(() => import("./probe-DT85QZBC.js"));
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
async function probeGatewayStatus(opts) {
	const kind = opts.requireRpc ? "read" : "connect";
	try {
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
				const { callGateway } = await import("./call-CuKQnsm3.js");
				await callGateway({
					url: opts.url,
					token: opts.token,
					password: opts.password,
					tlsFingerprint: opts.tlsFingerprint,
					...opts.config ? { config: opts.config } : {},
					method: "status",
					timeoutMs: opts.timeoutMs,
					...opts.configPath ? { configPath: opts.configPath } : {}
				});
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
		if (result.ok) return {
			ok: true,
			kind,
			capability: kind === "read" ? auth?.capability && auth.capability !== "unknown" ? auth.capability : "read_only" : auth?.capability,
			auth,
			...serverSummary
		};
		return {
			ok: false,
			kind,
			capability: auth?.capability,
			auth,
			...serverSummary,
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
