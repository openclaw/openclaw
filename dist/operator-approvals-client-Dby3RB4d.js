import { f as isLoopbackIpAddress } from "./ip-WAe3-2zT.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { t as startGatewayClientWhenEventLoopReady } from "./client-start-readiness-zY0I9Wur.js";
import { n as GatewayClient } from "./client-B1EH_7Mz.js";
import { t as getOperatorApprovalRuntimeToken } from "./operator-approval-runtime-token-C5pv_wEb.js";
import { t as resolveGatewayClientBootstrap } from "./client-bootstrap-BVdOqAXA.js";
//#region src/gateway/operator-approvals-client.ts
function isLoopbackGatewayUrl(rawUrl) {
	try {
		const hostname = new URL(rawUrl).hostname.toLowerCase();
		const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
		return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
	} catch {
		return false;
	}
}
function shouldOmitOperatorApprovalDeviceIdentity(params) {
	return Boolean((params.token || params.password) && isLoopbackGatewayUrl(params.url));
}
async function createOperatorApprovalsGatewayClient(params) {
	const bootstrap = await resolveGatewayClientBootstrap({
		config: params.config,
		gatewayUrl: params.gatewayUrl,
		env: process.env
	});
	return new GatewayClient({
		url: bootstrap.url,
		token: bootstrap.auth.token,
		password: bootstrap.auth.password,
		...params.gatewayUrl ? {} : { approvalRuntimeToken: getOperatorApprovalRuntimeToken() },
		preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
		clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
		clientDisplayName: params.clientDisplayName,
		mode: GATEWAY_CLIENT_MODES.BACKEND,
		scopes: ["operator.approvals"],
		deviceIdentity: shouldOmitOperatorApprovalDeviceIdentity({
			url: bootstrap.url,
			token: bootstrap.auth.token,
			password: bootstrap.auth.password
		}) ? null : void 0,
		onEvent: params.onEvent,
		onHelloOk: params.onHelloOk,
		onConnectError: params.onConnectError,
		onReconnectPaused: params.onReconnectPaused,
		onClose: params.onClose
	});
}
async function withOperatorApprovalsGatewayClient(params, run) {
	let readySettled = false;
	let resolveReady;
	let rejectReady;
	const ready = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const markReady = () => {
		if (readySettled) return;
		readySettled = true;
		resolveReady();
	};
	const failReady = (err) => {
		if (readySettled) return;
		readySettled = true;
		rejectReady(err);
	};
	const gatewayClient = await createOperatorApprovalsGatewayClient({
		config: params.config,
		gatewayUrl: params.gatewayUrl,
		clientDisplayName: params.clientDisplayName,
		onHelloOk: () => {
			markReady();
		},
		onConnectError: (err) => {
			failReady(err);
		},
		onClose: (code, reason) => {
			failReady(/* @__PURE__ */ new Error(`gateway closed (${code}): ${reason}`));
		}
	});
	try {
		const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, { clientOptions: { preauthHandshakeTimeoutMs: params.config.gateway?.handshakeTimeoutMs } });
		if (!readiness.ready) throw new Error(readiness.aborted ? "gateway approval client start aborted before readiness" : "gateway readiness unavailable before approval client start");
		await ready;
		return await run(gatewayClient);
	} finally {
		await gatewayClient.stopAndWait().catch(() => {
			gatewayClient.stop();
		});
	}
}
//#endregion
export { withOperatorApprovalsGatewayClient as n, createOperatorApprovalsGatewayClient as t };
