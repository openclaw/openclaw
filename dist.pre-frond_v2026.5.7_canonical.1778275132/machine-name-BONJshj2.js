import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/infra/machine-name.ts
const execFileAsync = promisify(execFile);
let cachedPromise = null;
async function tryScutil(key) {
	try {
		const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--get", key], {
			timeout: 1e3,
			windowsHide: true
		});
		const value = normalizeOptionalString(stdout ?? "") ?? "";
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}
function fallbackHostName() {
	return (normalizeOptionalString(os.hostname()) ?? "").replace(/\.local$/i, "") || "openclaw";
}
async function getMachineDisplayName() {
	if (cachedPromise) return cachedPromise;
	cachedPromise = (async () => {
		if (process.env.VITEST || false) return fallbackHostName();
		if (process.platform === "darwin") {
			const computerName = await tryScutil("ComputerName");
			if (computerName) return computerName;
			const localHostName = await tryScutil("LocalHostName");
			if (localHostName) return localHostName;
		}
		return fallbackHostName();
	})();
	return cachedPromise;
}
//#endregion
export { getMachineDisplayName as t };
