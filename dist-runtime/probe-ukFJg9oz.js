import { r as formatErrorMessage } from "./errors-CHvVoeNX.js";
import { En as GATEWAY_CLIENT_NAMES, Tn as GATEWAY_CLIENT_MODES, a as READ_SCOPE, u as GatewayClient } from "./method-scopes-DDb5C1xl.js";
import { a as isLoopbackHost } from "./device-metadata-normalization-a2oQYp64.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/probe.ts
async function probeGateway(opts) {
	const startedAt = Date.now();
	const instanceId = randomUUID();
	let connectLatencyMs = null;
	let connectError = null;
	let close = null;
	const disableDeviceIdentity = (() => {
		try {
			const hostname = new URL(opts.url).hostname;
			return isLoopbackHost(hostname) && !(opts.auth?.token || opts.auth?.password);
		} catch {
			return false;
		}
	})();
	const detailLevel = opts.includeDetails === false ? "none" : opts.detailLevel ?? "full";
	return await new Promise((resolve) => {
		let settled = false;
		const settle = (result) => {
			if (settled) {return;}
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
			deviceIdentity: disableDeviceIdentity ? null : void 0,
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
				if (detailLevel === "none") {
					settle({
						ok: true,
						connectLatencyMs,
						error: null,
						close,
						health: null,
						status: null,
						presence: null,
						configSnapshot: null
					});
					return;
				}
				try {
					if (detailLevel === "presence") {
						const presence = await client.request("system-presence");
						settle({
							ok: true,
							connectLatencyMs,
							error: null,
							close,
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
export { probeGateway as t };
