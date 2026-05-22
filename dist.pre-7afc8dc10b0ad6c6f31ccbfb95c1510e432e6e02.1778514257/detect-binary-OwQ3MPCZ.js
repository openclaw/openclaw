import { p as resolveUserPath } from "./utils-927g1oFZ.js";
import { r as runCommandWithTimeout } from "./exec-B7osikex.js";
import { t as isSafeExecutableValue } from "./exec-safety-A-Uxnzgo.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/infra/detect-binary.ts
async function detectBinary(name) {
	if (!name?.trim()) return false;
	if (!isSafeExecutableValue(name)) return false;
	const resolved = name.startsWith("~") ? resolveUserPath(name) : name;
	if (path.isAbsolute(resolved) || resolved.startsWith(".") || resolved.includes("/") || resolved.includes("\\")) try {
		await fs.access(resolved);
		return true;
	} catch {
		return false;
	}
	const command = process.platform === "win32" ? ["where", name] : [
		"/usr/bin/env",
		"which",
		name
	];
	try {
		const result = await runCommandWithTimeout(command, { timeoutMs: 2e3 });
		return result.code === 0 && result.stdout.trim().length > 0;
	} catch {
		return false;
	}
}
//#endregion
export { detectBinary as t };
