import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { a as asRecord } from "./record-coerce-BjNW89OI.js";
//#region src/shared/node-list-parse.ts
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
	return normalizeLowercaseStringOrEmpty(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}
function listKnownNodes(nodes) {
	return nodes.map((n) => n.displayName || n.remoteIp || n.nodeId).filter(Boolean).join(", ");
}
function formatNodeCandidateLabel(node) {
	const label = node.displayName || node.remoteIp || node.nodeId;
	const details = [`node=${node.nodeId}`];
	const clientId = normalizeOptionalString(node.clientId);
	if (clientId) details.push(`client=${clientId}`);
	return `${label} [${details.join(", ")}]`;
}
function isCurrentOpenClawClient(clientId) {
	return (normalizeOptionalLowercaseString(clientId) ?? "").startsWith("openclaw-");
}
function isLegacyClawdbotClient(clientId) {
	const normalized = normalizeOptionalLowercaseString(clientId) ?? "";
	return normalized.startsWith("clawdbot-") || normalized.startsWith("moldbot-");
}
function pickPreferredLegacyMigrationMatch(matches) {
	const current = matches.filter((match) => isCurrentOpenClawClient(match.clientId));
	if (current.length !== 1) return;
	const legacyCount = matches.filter((match) => isLegacyClawdbotClient(match.clientId)).length;
	if (legacyCount === 0 || current.length + legacyCount !== matches.length) return;
	return current[0];
}
function resolveMatchScore(node, query, queryNormalized) {
	if (node.nodeId === query) return 4e3;
	if (typeof node.remoteIp === "string" && node.remoteIp === query) return 3e3;
	const name = typeof node.displayName === "string" ? node.displayName : "";
	if (name && normalizeNodeKey(name) === queryNormalized) return 2e3;
	if (query.length >= 6 && node.nodeId.startsWith(query)) return 1e3;
	return 0;
}
function scoreNodeCandidate(node, matchScore) {
	let score = matchScore;
	if (node.connected === true) score += 100;
	if (isCurrentOpenClawClient(node.clientId)) score += 10;
	else if (isLegacyClawdbotClient(node.clientId)) score -= 10;
	return score;
}
function resolveScoredMatches(nodes, query) {
	const trimmed = normalizeOptionalString(query);
	if (!trimmed) return [];
	const normalized = normalizeNodeKey(trimmed);
	return nodes.map((node) => {
		const matchScore = resolveMatchScore(node, trimmed, normalized);
		if (matchScore === 0) return null;
		return {
			node,
			matchScore,
			selectionScore: scoreNodeCandidate(node, matchScore)
		};
	}).filter((entry) => entry !== null);
}
function resolveNodeIdFromCandidates(nodes, query) {
	const q = query.trim();
	if (!q) throw new Error("node required");
	const rawMatches = resolveScoredMatches(nodes, q);
	if (rawMatches.length === 1) return rawMatches[0]?.node.nodeId ?? "";
	if (rawMatches.length === 0) {
		const known = listKnownNodes(nodes);
		throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
	}
	const topMatchScore = Math.max(...rawMatches.map((match) => match.matchScore));
	const strongestMatches = rawMatches.filter((match) => match.matchScore === topMatchScore);
	if (strongestMatches.length === 1) return strongestMatches[0]?.node.nodeId ?? "";
	const topSelectionScore = Math.max(...strongestMatches.map((match) => match.selectionScore));
	const matches = strongestMatches.filter((match) => match.selectionScore === topSelectionScore);
	if (matches.length === 1) return matches[0]?.node.nodeId ?? "";
	const preferred = pickPreferredLegacyMigrationMatch(matches.map((match) => match.node));
	if (preferred) return preferred.nodeId;
	throw new Error(`ambiguous node: ${q} (matches: ${matches.map((match) => formatNodeCandidateLabel(match.node)).join(", ")})`);
}
//#endregion
//#region src/shared/node-resolve.ts
function resolveNodeIdFromNodeList(nodes, query, options = {}) {
	const q = normalizeOptionalString(query) ?? "";
	if (!q) {
		if (options.allowDefault === true && options.pickDefaultNode) {
			const picked = options.pickDefaultNode(nodes);
			if (picked) return picked.nodeId;
		}
		throw new Error("node required");
	}
	return resolveNodeIdFromCandidates(nodes, q);
}
function resolveNodeFromNodeList(nodes, query, options = {}) {
	const nodeId = resolveNodeIdFromNodeList(nodes, query, options);
	return nodes.find((node) => node.nodeId === nodeId) ?? { nodeId };
}
//#endregion
export { parsePairingList as i, resolveNodeIdFromNodeList as n, parseNodeList as r, resolveNodeFromNodeList as t };
