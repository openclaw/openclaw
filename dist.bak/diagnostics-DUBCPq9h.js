import { s as resolveGatewayLogPaths } from "./service-gv1-6Hix.js";
import fs from "node:fs/promises";

//#region src/daemon/diagnostics.ts
const GATEWAY_LOG_ERROR_PATTERNS = [
	/refusing to bind gateway/i,
	/gateway auth mode/i,
	/gateway start blocked/i,
	/failed to bind gateway socket/i,
	/tailscale .* requires/i
];
async function readLastLogLine(filePath) {
	try {
		const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/).map((line) => line.trim());
		for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i]) return lines[i];
		return null;
	} catch {
		return null;
	}
}
async function readLastGatewayErrorLine(env) {
	const { stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
	const stderrRaw = await fs.readFile(stderrPath, "utf8").catch(() => "");
	const stdoutRaw = await fs.readFile(stdoutPath, "utf8").catch(() => "");
	const lines = [...stderrRaw.split(/\r?\n/), ...stdoutRaw.split(/\r?\n/)].map((line) => line.trim());
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (!line) continue;
		if (GATEWAY_LOG_ERROR_PATTERNS.some((pattern) => pattern.test(line))) return line;
	}
	return await readLastLogLine(stderrPath) ?? await readLastLogLine(stdoutPath);
}

//#endregion
export { readLastGatewayErrorLine as t };