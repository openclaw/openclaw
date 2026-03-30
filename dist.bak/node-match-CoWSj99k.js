//#region src/shared/node-list-parse.ts
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : {};
}
function parsePairingList(value) {
	const obj = asRecord(value);
	return {
		pending: Array.isArray(obj.pending) ? obj.pending : [],
		paired: Array.isArray(obj.paired) ? obj.paired : []
	};
}
function parseNodeList(value) {
	const obj = asRecord(value);
	return Array.isArray(obj.nodes) ? obj.nodes : [];
}

//#endregion
//#region src/shared/node-match.ts
function normalizeNodeKey(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}
function listKnownNodes(nodes) {
	return nodes.map((n) => n.displayName || n.remoteIp || n.nodeId).filter(Boolean).join(", ");
}
function resolveNodeMatches(nodes, query) {
	const q = query.trim();
	if (!q) return [];
	const qNorm = normalizeNodeKey(q);
	return nodes.filter((n) => {
		if (n.nodeId === q) return true;
		if (typeof n.remoteIp === "string" && n.remoteIp === q) return true;
		const name = typeof n.displayName === "string" ? n.displayName : "";
		if (name && normalizeNodeKey(name) === qNorm) return true;
		if (q.length >= 6 && n.nodeId.startsWith(q)) return true;
		return false;
	});
}
function resolveNodeIdFromCandidates(nodes, query) {
	const q = query.trim();
	if (!q) throw new Error("node required");
	const rawMatches = resolveNodeMatches(nodes, q);
	if (rawMatches.length === 1) return rawMatches[0]?.nodeId ?? "";
	if (rawMatches.length === 0) {
		const known = listKnownNodes(nodes);
		throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
	}
	const connectedMatches = rawMatches.filter((match) => match.connected === true);
	const matches = connectedMatches.length > 0 ? connectedMatches : rawMatches;
	if (matches.length === 1) return matches[0]?.nodeId ?? "";
	throw new Error(`ambiguous node: ${q} (matches: ${matches.map((n) => n.displayName || n.remoteIp || n.nodeId).join(", ")})`);
}

//#endregion
export { parseNodeList as n, parsePairingList as r, resolveNodeIdFromCandidates as t };