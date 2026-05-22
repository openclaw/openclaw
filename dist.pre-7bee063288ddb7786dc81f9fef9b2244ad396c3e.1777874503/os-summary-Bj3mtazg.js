import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import os from "node:os";
import { spawnSync } from "node:child_process";
//#region src/infra/os-summary.ts
const cachedOsSummaryByKey = /* @__PURE__ */ new Map();
function macosVersion() {
	return (normalizeOptionalString(spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" }).stdout) ?? "") || os.release();
}
function resolveOsSummary() {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	const cacheKey = `${platform}\0${release}\0${arch}`;
	const cached = cachedOsSummaryByKey.get(cacheKey);
	if (cached) return cached;
	const summary = {
		platform,
		arch,
		release,
		label: (() => {
			if (platform === "darwin") return `macos ${macosVersion()} (${arch})`;
			if (platform === "win32") return `windows ${release} (${arch})`;
			return `${platform} ${release} (${arch})`;
		})()
	};
	cachedOsSummaryByKey.set(cacheKey, summary);
	return summary;
}
//#endregion
export { resolveOsSummary as t };
