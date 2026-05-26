import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as callGatewayTool } from "./gateway-CnPnSTsW.js";
import { n as parsePairingList, t as parseNodeList } from "./node-list-parse-BsVX55PX.js";
import { n as resolveNodeIdFromNodeList, t as resolveNodeFromNodeList } from "./node-resolve-WWdIs9XF.js";
//#region src/agents/tools/nodes-utils.ts
function messageFromError(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	if (typeof error === "object" && error !== null) try {
		return JSON.stringify(error);
	} catch {
		return "";
	}
	return "";
}
function shouldFallbackToPairList(error) {
	const message = normalizeOptionalLowercaseString(messageFromError(error)) ?? "";
	if (!message.includes("node.list")) return false;
	return message.includes("unknown method") || message.includes("method not found") || message.includes("not implemented") || message.includes("unsupported");
}
async function loadNodes(opts) {
	try {
		return parseNodeList(await callGatewayTool("node.list", opts, {}));
	} catch (error) {
		if (!shouldFallbackToPairList(error)) throw error;
		const { paired } = parsePairingList(await callGatewayTool("node.pair.list", opts, {}));
		return paired.map((n) => ({
			nodeId: n.nodeId,
			displayName: n.displayName,
			platform: n.platform,
			remoteIp: n.remoteIp
		}));
	}
}
function isLocalMacNode(node) {
	return normalizeOptionalLowercaseString(node.platform)?.startsWith("mac") === true && typeof node.nodeId === "string" && node.nodeId.startsWith("mac-");
}
function compareDefaultNodeOrder(a, b) {
	const aConnectedAt = Number.isFinite(a.connectedAtMs) ? a.connectedAtMs ?? 0 : -1;
	const bConnectedAt = Number.isFinite(b.connectedAtMs) ? b.connectedAtMs ?? 0 : -1;
	if (aConnectedAt !== bConnectedAt) return bConnectedAt - aConnectedAt;
	return a.nodeId.localeCompare(b.nodeId);
}
function selectDefaultNodeFromList(nodes, options = {}) {
	const capability = options.capability?.trim();
	const withCapability = capability ? nodes.filter((n) => Array.isArray(n.caps) ? n.caps.includes(capability) : true) : nodes;
	if (withCapability.length === 0) return null;
	const connected = withCapability.filter((n) => n.connected);
	const candidates = connected.length > 0 ? connected : withCapability;
	if (candidates.length === 1) return candidates[0];
	if (options.preferLocalMac ?? true) {
		const local = candidates.filter(isLocalMacNode);
		if (local.length === 1) return local[0];
	}
	if ((options.fallback ?? "none") === "none") return null;
	return [...candidates].toSorted(compareDefaultNodeOrder)[0] ?? null;
}
function pickDefaultNode(nodes) {
	return selectDefaultNodeFromList(nodes, {
		capability: "canvas",
		fallback: "first",
		preferLocalMac: true
	});
}
async function listNodes(opts) {
	return loadNodes(opts);
}
function resolveNodeIdFromList(nodes, query, allowDefault = false) {
	return resolveNodeIdFromNodeList(nodes, query, {
		allowDefault,
		pickDefaultNode
	});
}
async function resolveNodeId(opts, query, allowDefault = false) {
	return (await resolveNode(opts, query, allowDefault)).nodeId;
}
async function resolveNode(opts, query, allowDefault = false) {
	return resolveNodeFromNodeList(await loadNodes(opts), query, {
		allowDefault,
		pickDefaultNode
	});
}
//#endregion
export { selectDefaultNodeFromList as a, resolveNodeIdFromList as i, resolveNode as n, resolveNodeId as r, listNodes as t };
