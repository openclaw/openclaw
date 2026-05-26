import { i as isPathInside } from "./path-BlG8lhgR.js";
import { b as assertNoWindowsNetworkPath } from "./fs-safe-CV86zY9G.js";
import "./path-guards-CBe_wA_B.js";
import "./local-file-access-CBe_wA_B.js";
import { i as resolveInboundMediaReference } from "./media-reference-efB9JQqF.js";
import { a as getDefaultMediaLocalRoots } from "./local-roots-Pi6a9oaK.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/media/local-media-access.ts
var LocalMediaAccessError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "LocalMediaAccessError";
	}
};
function getDefaultLocalRoots() {
	return getDefaultMediaLocalRoots();
}
async function assertLocalMediaAllowed(mediaPath, localRoots) {
	if (localRoots === "any") return;
	if (await resolveInboundMediaReference(mediaPath).catch(() => null)) return;
	try {
		assertNoWindowsNetworkPath(mediaPath, "Local media path");
	} catch (err) {
		throw new LocalMediaAccessError("network-path-not-allowed", err.message, { cause: err });
	}
	const roots = localRoots ?? getDefaultLocalRoots();
	let resolved;
	try {
		resolved = await fs.realpath(mediaPath);
	} catch {
		resolved = path.resolve(mediaPath);
	}
	if (localRoots === void 0) {
		const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
		if (workspaceRoot) {
			const stateDir = path.dirname(workspaceRoot);
			const rel = path.relative(stateDir, resolved);
			if (rel && isPathInside(stateDir, resolved)) {
				if ((rel.split(path.sep)[0] ?? "").startsWith("workspace-")) throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
			}
		}
	}
	for (const root of roots) {
		let resolvedRoot;
		try {
			resolvedRoot = await fs.realpath(root);
		} catch {
			resolvedRoot = path.resolve(root);
		}
		if (resolvedRoot === path.parse(resolvedRoot).root) throw new LocalMediaAccessError("invalid-root", `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`);
		if (isPathInside(resolvedRoot, resolved)) return;
	}
	throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
}
//#endregion
export { assertLocalMediaAllowed as n, getDefaultLocalRoots as r, LocalMediaAccessError as t };
