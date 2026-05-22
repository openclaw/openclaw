import path from "node:path";
import fs from "node:fs/promises";
//#region src/infra/stable-node-path.ts
/**
* Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
* break when Homebrew upgrades Node and removes the old version directory.
* Resolve these to a stable Homebrew-managed path that survives upgrades:
*   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
*   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
*/
async function resolveStableNodePath(nodePath) {
	const cellarMatch = nodePath.match(/^(.+?)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/);
	if (!cellarMatch) return nodePath;
	const prefix = cellarMatch[1];
	const formula = cellarMatch[2];
	const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;
	const optPath = pathModule.join(prefix, "opt", formula, "bin", "node");
	try {
		await fs.access(optPath);
		return optPath;
	} catch {}
	if (formula === "node") {
		const binPath = pathModule.join(prefix, "bin", "node");
		try {
			await fs.access(binPath);
			return binPath;
		} catch {}
	}
	return nodePath;
}
//#endregion
export { resolveStableNodePath as t };
