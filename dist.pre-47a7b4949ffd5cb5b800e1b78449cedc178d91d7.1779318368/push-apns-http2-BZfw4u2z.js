import { n as getActiveManagedProxyTlsOptions, r as getActiveManagedProxyUrl } from "./active-proxy-state-BBaqWhZo.js";
import * as net$1 from "node:net";
import * as tls$1 from "node:tls";
import http2 from "node:http2";
//#region src/infra/net/http-connect-tunnel.ts
const MAX_CONNECT_RESPONSE_HEADER_BYTES = 16 * 1024;
function redactProxyUrl(proxyUrl) {
	try {
		return proxyUrl.origin;
	} catch {
		return "<invalid proxy URL>";
	}
}
function resolveProxyHost(proxy) {
	return (proxy.hostname || proxy.host).replace(/^\[|\]$/g, "");
}
function resolveProxyPort(proxy) {
	if (proxy.port) return Number(proxy.port);
	return proxy.protocol === "https:" ? 443 : 80;
}
function resolveProxyAuthorization(proxy) {
	if (!proxy.username && !proxy.password) return;
	const username = decodeURIComponent(proxy.username);
	const password = decodeURIComponent(proxy.password);
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
function formatTunnelFailure(proxyUrl, err) {
	return new Error(`Proxy CONNECT failed via ${redactProxyUrl(proxyUrl)}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
}
function writeConnectRequest(socket, proxy, target) {
	const headers = [
		`CONNECT ${target} HTTP/1.1`,
		`Host: ${target}`,
		"Proxy-Connection: Keep-Alive"
	];
	const authorization = resolveProxyAuthorization(proxy);
	if (authorization) headers.push(`Proxy-Authorization: ${authorization}`);
	socket.write([
		...headers,
		"",
		""
	].join("\r\n"));
}
function assertConnectHeaderBytesWithinLimit(size) {
	if (size > MAX_CONNECT_RESPONSE_HEADER_BYTES) throw new Error(`Proxy CONNECT response headers exceeded ${MAX_CONNECT_RESPONSE_HEADER_BYTES} bytes`);
}
function readProxyConnectResponse(responseBuffer, chunk) {
	const nextBuffer = Buffer.concat([responseBuffer, chunk]);
	const headerEnd = nextBuffer.indexOf("\r\n\r\n");
	if (headerEnd === -1) {
		assertConnectHeaderBytesWithinLimit(nextBuffer.length);
		return {
			kind: "incomplete",
			responseBuffer: nextBuffer
		};
	}
	const bodyOffset = headerEnd + 4;
	assertConnectHeaderBytesWithinLimit(bodyOffset);
	return {
		kind: "complete",
		responseBuffer: nextBuffer,
		statusLine: nextBuffer.subarray(0, bodyOffset).toString("latin1").split("\r\n", 1)[0] ?? "",
		tunneledBytes: nextBuffer.length > bodyOffset ? nextBuffer.subarray(bodyOffset) : void 0
	};
}
function isSuccessfulConnectStatusLine(statusLine) {
	return /^HTTP\/1\.[01] 2\d\d\b/.test(statusLine);
}
function connectToProxy(proxy, proxyTls) {
	const proxyHost = resolveProxyHost(proxy);
	const proxyServername = net$1.isIP(proxyHost) === 0 ? proxyHost : void 0;
	const connectOptions = {
		host: proxyHost,
		port: resolveProxyPort(proxy)
	};
	if (proxy.protocol === "https:") return tls$1.connect({
		...connectOptions,
		...proxyServername ? { servername: proxyServername } : {},
		ALPNProtocols: ["http/1.1"],
		...proxyTls?.ca ? { ca: proxyTls.ca } : {}
	});
	return net$1.connect(connectOptions);
}
var HttpConnectTunnelAttempt = class {
	constructor(params, proxy, resolve, reject) {
		this.params = params;
		this.proxy = proxy;
		this.resolve = resolve;
		this.reject = reject;
		this.settled = false;
		this.responseBuffer = Buffer.alloc(0);
		this.fail = (err) => {
			if (this.settled) return;
			this.settled = true;
			this.clearTimer();
			this.cleanupProxyListeners();
			this.cleanupTargetTlsListeners();
			this.targetTlsSocket?.destroy();
			this.proxySocket?.destroy();
			this.reject(formatTunnelFailure(this.params.proxyUrl, err));
		};
		this.onProxyConnected = () => {
			const socket = this.proxySocket;
			if (!socket) {
				this.fail(/* @__PURE__ */ new Error("Proxy socket missing after connect"));
				return;
			}
			const target = `${this.params.targetHost}:${this.params.targetPort}`;
			try {
				writeConnectRequest(socket, this.proxy, target);
			} catch (err) {
				this.fail(err);
			}
		};
		this.onProxyData = (chunk) => {
			let result;
			try {
				result = readProxyConnectResponse(this.responseBuffer, chunk);
			} catch (err) {
				this.fail(err);
				return;
			}
			this.responseBuffer = result.responseBuffer;
			if (result.kind === "incomplete") return;
			const socket = this.proxySocket;
			if (!socket) {
				this.fail(/* @__PURE__ */ new Error("Proxy socket missing after CONNECT response"));
				return;
			}
			if (result.tunneledBytes) socket.unshift(result.tunneledBytes);
			if (!isSuccessfulConnectStatusLine(result.statusLine)) {
				this.fail(new Error(result.statusLine || "Proxy returned an invalid CONNECT response"));
				return;
			}
			this.cleanupProxyListeners();
			this.startTargetTls(socket);
		};
		this.onTargetSecureConnect = () => {
			const socket = this.targetTlsSocket;
			if (!socket) {
				this.fail(/* @__PURE__ */ new Error("APNs TLS socket missing after secureConnect"));
				return;
			}
			if (socket.alpnProtocol !== "h2") {
				const negotiated = socket.alpnProtocol || "no ALPN protocol";
				this.fail(/* @__PURE__ */ new Error(`APNs TLS tunnel negotiated ${negotiated} instead of h2`));
				return;
			}
			this.succeed(socket);
		};
		this.onTargetTlsClosedBeforeSecureConnect = () => {
			this.fail(/* @__PURE__ */ new Error("APNs TLS tunnel closed before secureConnect"));
		};
		this.onProxyClosedBeforeConnect = () => {
			this.fail(/* @__PURE__ */ new Error("Proxy closed before CONNECT response"));
		};
	}
	start() {
		try {
			this.startTimeout();
			this.proxySocket = connectToProxy(this.proxy, this.params.proxyTls);
			this.proxySocket.once(this.proxy.protocol === "https:" ? "secureConnect" : "connect", this.onProxyConnected);
			this.proxySocket.on("data", this.onProxyData);
			this.proxySocket.once("end", this.onProxyClosedBeforeConnect);
			this.proxySocket.once("error", this.fail);
			this.proxySocket.once("close", this.onProxyClosedBeforeConnect);
		} catch (err) {
			this.fail(err);
		}
	}
	startTimeout() {
		const timeoutMs = this.params.timeoutMs;
		if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) this.timeout = setTimeout(() => {
			this.fail(/* @__PURE__ */ new Error(`Proxy CONNECT timed out after ${Math.trunc(timeoutMs)}ms`));
		}, Math.trunc(timeoutMs));
	}
	clearTimer() {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = void 0;
		}
	}
	cleanupProxyListeners() {
		const socket = this.proxySocket;
		if (!socket) return;
		socket.off("data", this.onProxyData);
		socket.off("end", this.onProxyClosedBeforeConnect);
		socket.off("error", this.fail);
		socket.off("close", this.onProxyClosedBeforeConnect);
		socket.off("connect", this.onProxyConnected);
		socket.off("secureConnect", this.onProxyConnected);
	}
	cleanupTargetTlsListeners() {
		const socket = this.targetTlsSocket;
		if (!socket) return;
		socket.off("secureConnect", this.onTargetSecureConnect);
		socket.off("error", this.fail);
		socket.off("close", this.onTargetTlsClosedBeforeSecureConnect);
	}
	succeed(socket) {
		if (this.settled) {
			socket.destroy();
			return;
		}
		this.settled = true;
		this.clearTimer();
		this.cleanupProxyListeners();
		this.cleanupTargetTlsListeners();
		this.resolve(socket);
	}
	startTargetTls(socket) {
		try {
			this.targetTlsSocket = tls$1.connect({
				socket,
				servername: this.params.targetHost,
				ALPNProtocols: ["h2"]
			});
			this.targetTlsSocket.once("secureConnect", this.onTargetSecureConnect);
			this.targetTlsSocket.once("error", this.fail);
			this.targetTlsSocket.once("close", this.onTargetTlsClosedBeforeSecureConnect);
		} catch (err) {
			this.fail(err);
		}
	}
};
async function openHttpConnectTunnel(params) {
	const proxy = new URL(params.proxyUrl.href);
	if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new Error(`Unsupported proxy protocol for APNs HTTP/2 CONNECT tunnel: ${proxy.protocol}`);
	return await new Promise((resolve, reject) => {
		new HttpConnectTunnelAttempt(params, proxy, resolve, reject).start();
	});
}
//#endregion
//#region src/infra/push-apns-http2.ts
const APNS_DEFAULT_PORT = "443";
const APNS_AUTHORITIES = new Set(["https://api.push.apple.com", "https://api.sandbox.push.apple.com"]);
const APNS_HTTP2_CANCEL_CODE = http2.constants.NGHTTP2_CANCEL;
function assertApnsAuthority(authority) {
	let parsed;
	try {
		parsed = new URL(authority);
	} catch {
		throw new Error(`Unsupported APNs authority: ${authority}`);
	}
	if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`Unsupported APNs authority: ${authority}`);
	const port = parsed.port && parsed.port !== APNS_DEFAULT_PORT ? `:${parsed.port}` : "";
	const normalized = `${parsed.protocol}//${parsed.hostname}${port}`;
	if (!APNS_AUTHORITIES.has(normalized)) throw new Error(`Unsupported APNs authority: ${authority}`);
	return normalized;
}
async function openProxiedApnsHttp2Session(params) {
	const apnsHost = new URL(params.authority).hostname;
	const tlsSocket = await openHttpConnectTunnel({
		proxyUrl: params.proxyUrl,
		...params.proxyTls ? { proxyTls: params.proxyTls } : {},
		targetHost: apnsHost,
		targetPort: 443,
		timeoutMs: params.timeoutMs
	});
	return http2.connect(params.authority, { createConnection: () => tlsSocket });
}
async function connectApnsHttp2Session(params) {
	const authority = assertApnsAuthority(params.authority);
	const proxyUrl = getActiveManagedProxyUrl();
	if (!proxyUrl) return http2.connect(authority);
	return await openProxiedApnsHttp2Session({
		authority,
		proxyUrl,
		proxyTls: getActiveManagedProxyTlsOptions(),
		timeoutMs: params.timeoutMs
	});
}
async function probeApnsHttp2ReachabilityViaProxy(params) {
	const session = await openProxiedApnsHttp2Session({
		authority: assertApnsAuthority(params.authority),
		proxyUrl: new URL(params.proxyUrl),
		...params.proxyTls ? { proxyTls: params.proxyTls } : {},
		timeoutMs: params.timeoutMs
	});
	try {
		return await new Promise((resolve, reject) => {
			let settled = false;
			let body = "";
			let status;
			let responseHeaders = {};
			const timeout = setTimeout(() => {
				fail(/* @__PURE__ */ new Error(`APNs reachability probe timed out after ${Math.trunc(params.timeoutMs)}ms`));
			}, Math.trunc(params.timeoutMs));
			timeout.unref?.();
			const cleanup = () => {
				clearTimeout(timeout);
				session.off("error", fail);
			};
			const fail = (err) => {
				if (settled) return;
				settled = true;
				cleanup();
				session.destroy(err instanceof Error ? err : new Error(String(err)));
				reject(err);
			};
			const request = session.request({
				":method": "POST",
				":path": `/3/device/${"0".repeat(64)}`,
				authorization: "bearer intentionally.invalid.openclaw.proxy.validation",
				"apns-topic": "ai.openclaw.ios",
				"apns-push-type": "alert",
				"apns-priority": "10"
			});
			session.once("error", fail);
			request.setEncoding("utf8");
			request.on("response", (headers) => {
				const rawStatus = headers[":status"];
				status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
				responseHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(":")).map(([k, v]) => [k, String(v)]));
			});
			request.on("data", (chunk) => {
				body += String(chunk);
			});
			request.once("error", fail);
			request.once("end", () => {
				if (settled) return;
				settled = true;
				cleanup();
				if (status === void 0 || !Number.isFinite(status)) {
					reject(/* @__PURE__ */ new Error("APNs reachability probe ended without an HTTP/2 status"));
					return;
				}
				resolve({
					status,
					body,
					responseHeaders
				});
			});
			request.end(JSON.stringify({ aps: { alert: "OpenClaw APNs proxy validation" } }));
		});
	} finally {
		if (!session.closed && !session.destroyed) session.close();
	}
}
//#endregion
export { connectApnsHttp2Session as n, probeApnsHttp2ReachabilityViaProxy as r, APNS_HTTP2_CANCEL_CODE as t };
