import { a as normalizeLowercaseStringOrEmpty, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { n as parsePairingList, t as parseNodeList } from "./node-list-parse-BsVX55PX.js";
import { t as resolveNodeFromNodeList } from "./node-resolve-WWdIs9XF.js";
import { randomUUID } from "node:crypto";
//#region src/cli/nodes-cli/format.ts
function formatPermissions(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const entries = Object.entries(raw).map(([key, value]) => [normalizeStringifiedOptionalString(key) ?? "", value === true]).filter(([key]) => key.length > 0).toSorted((a, b) => a[0].localeCompare(b[0]));
	if (entries.length === 0) return null;
	return `[${entries.map(([key, granted]) => `${key}=${granted ? "yes" : "no"}`).join(", ")}]`;
}
//#endregion
//#region src/cli/nodes-cli/rpc.ts
const nodesCliRpcRuntimeLoader = createLazyImportLoader(() => import("./rpc.runtime.js"));
async function loadNodesCliRpcRuntime() {
	return nodesCliRpcRuntimeLoader.load();
}
const nodesCallOpts = (cmd, defaults) => cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 1e4)).option("--json", "Output JSON", false);
const callGatewayCli = async (method, opts, params, callOpts) => {
	return await (await loadNodesCliRpcRuntime()).callGatewayCliRuntime(method, opts, params, callOpts);
};
const callNodePairApprovalGatewayCli = async (method, opts, params, callOpts) => {
	return await (await loadNodesCliRpcRuntime()).callNodePairApprovalGatewayCliRuntime(method, opts, params, callOpts);
};
function buildNodeInvokeParams(params) {
	const invokeParams = {
		nodeId: params.nodeId,
		command: params.command,
		params: params.params,
		idempotencyKey: params.idempotencyKey ?? randomUUID()
	};
	if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) invokeParams.timeoutMs = params.timeoutMs;
	return invokeParams;
}
function unauthorizedHintForMessage(message) {
	const haystack = normalizeLowercaseStringOrEmpty(message);
	if (haystack.includes("unauthorizedclient") || haystack.includes("bridge client is not authorized") || haystack.includes("unsigned bridge clients are not allowed")) return [
		"peekaboo bridge rejected the client.",
		"sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with",
		"PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev."
	].join(" ");
	return null;
}
async function resolveNodeId(opts, query) {
	return (await resolveNode(opts, query)).nodeId;
}
async function resolveNode(opts, query) {
	let nodes = [];
	try {
		nodes = parseNodeList(await callGatewayCli("node.list", opts, {}));
	} catch {
		const { paired } = parsePairingList(await callGatewayCli("node.pair.list", opts, {}));
		nodes = paired.map((n) => ({
			nodeId: n.nodeId,
			displayName: n.displayName,
			platform: n.platform,
			version: n.version,
			remoteIp: n.remoteIp
		}));
	}
	return resolveNodeFromNodeList(nodes, query);
}
//#endregion
export { resolveNode as a, formatPermissions as c, nodesCallOpts as i, callGatewayCli as n, resolveNodeId as o, callNodePairApprovalGatewayCli as r, unauthorizedHintForMessage as s, buildNodeInvokeParams as t };
