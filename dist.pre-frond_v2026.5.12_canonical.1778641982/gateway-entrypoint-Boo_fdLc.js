import { u as pathExists } from "./utils-D5swhEXt.js";
import path from "node:path";
//#region src/daemon/gateway-entrypoint.ts
const GATEWAY_DIST_ENTRYPOINT_BASENAMES = [
	"index.js",
	"index.mjs",
	"entry.js",
	"entry.mjs"
];
function isGatewayDistEntrypointPath(inputPath) {
	return /[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(inputPath);
}
function buildGatewayInstallEntrypointCandidates(root) {
	if (!root) return [];
	return GATEWAY_DIST_ENTRYPOINT_BASENAMES.map((basename) => path.join(root, "dist", basename));
}
function buildGatewayDistEntrypointCandidates(...inputs) {
	const distDirs = [];
	const seenDirs = /* @__PURE__ */ new Set();
	for (const inputPath of inputs) {
		if (!isGatewayDistEntrypointPath(inputPath)) continue;
		const distDir = path.dirname(inputPath);
		if (seenDirs.has(distDir)) continue;
		seenDirs.add(distDir);
		distDirs.push(distDir);
	}
	const candidates = [];
	for (const basename of GATEWAY_DIST_ENTRYPOINT_BASENAMES) for (const distDir of distDirs) candidates.push(path.join(distDir, basename));
	return candidates;
}
async function findFirstAccessibleGatewayEntrypoint(candidates, exists = pathExists) {
	for (const candidate of candidates) if (await exists(candidate)) return candidate;
}
async function resolveGatewayInstallEntrypoint(root, exists = pathExists) {
	return findFirstAccessibleGatewayEntrypoint(buildGatewayInstallEntrypointCandidates(root), exists);
}
//#endregion
export { resolveGatewayInstallEntrypoint as i, findFirstAccessibleGatewayEntrypoint as n, isGatewayDistEntrypointPath as r, buildGatewayDistEntrypointCandidates as t };
