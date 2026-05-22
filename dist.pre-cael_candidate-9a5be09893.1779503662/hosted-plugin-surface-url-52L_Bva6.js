import { i as isLoopbackHost } from "./net-DCUMtgJy.js";
//#region src/gateway/hosted-plugin-surface-url.ts
const normalizeHost = (value, rejectLoopback) => {
	if (!value) return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (rejectLoopback && isLoopbackHost(trimmed)) return "";
	return trimmed;
};
const parseHostHeader = (value) => {
	if (!value) return { host: "" };
	try {
		const parsed = new URL(`http://${value.trim()}`);
		const portRaw = parsed.port.trim();
		const port = portRaw ? Number.parseInt(portRaw, 10) : void 0;
		return {
			host: parsed.hostname,
			port: Number.isFinite(port) ? port : void 0
		};
	} catch {
		return { host: "" };
	}
};
const parseForwardedProto = (value) => {
	if (Array.isArray(value)) return value[0];
	return value;
};
const parseForwardedHost = (value) => {
	return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
};
function resolveHostedPluginSurfaceUrl(params) {
	const port = params.port;
	if (!port) return;
	const scheme = parseForwardedProto(params.forwardedProto)?.trim() === "https" ? "https" : params.scheme ?? "http";
	const override = normalizeHost(params.hostOverride, true);
	const parsedForwardedHost = parseHostHeader(parseForwardedHost(params.forwardedHost));
	const parsedRequestHost = parseHostHeader(params.requestHost);
	const requestHost = normalizeHost(parsedRequestHost.host, !!override);
	const forwardedHost = normalizeHost(parsedForwardedHost.host, !!override);
	const advertisedHost = forwardedHost ? parsedForwardedHost : parsedRequestHost;
	const localAddress = normalizeHost(params.localAddress, Boolean(override || forwardedHost || requestHost));
	const host = override || forwardedHost || requestHost || localAddress;
	if (!host) return;
	let exposedPort = port;
	if (!override && (forwardedHost || requestHost) && port === 18789) {
		if (advertisedHost.port && advertisedHost.port > 0) exposedPort = advertisedHost.port;
		else if (scheme === "https") exposedPort = 443;
		else if (scheme === "http") exposedPort = 80;
	}
	return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${exposedPort}`;
}
//#endregion
export { resolveHostedPluginSurfaceUrl as t };
