import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/cli/startup-metadata.ts
const STARTUP_METADATA_FILE = "cli-startup-metadata.json";
const startupMetadataByPath = /* @__PURE__ */ new Map();
function resolveStartupMetadataPathCandidates(moduleUrl) {
	const moduleDir = path.dirname(fileURLToPath(moduleUrl));
	return [path.resolve(moduleDir, STARTUP_METADATA_FILE), path.resolve(moduleDir, "..", STARTUP_METADATA_FILE)];
}
function readCliStartupMetadata(moduleUrl) {
	for (const metadataPath of resolveStartupMetadataPathCandidates(moduleUrl)) {
		const cached = startupMetadataByPath.get(metadataPath);
		if (cached !== void 0) {
			if (cached) return cached;
			continue;
		}
		try {
			const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
			startupMetadataByPath.set(metadataPath, parsed);
			return parsed;
		} catch {
			startupMetadataByPath.set(metadataPath, null);
		}
	}
	return null;
}
//#endregion
export { readCliStartupMetadata as t };
