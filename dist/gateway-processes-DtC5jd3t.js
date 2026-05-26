import { n as parseProcCmdline, t as isGatewayArgv } from "./gateway-process-argv-0KsxsGrA.js";
import { a as readWindowsProcessArgsSync, i as readWindowsListeningPidsOnPortSync, n as findGatewayPidsOnPortSync } from "./restart-stale-pids-BubeCFq3.js";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
//#region src/infra/gateway-processes.ts
function readGatewayProcessArgsSync(pid) {
	if (process.platform === "linux") try {
		return parseProcCmdline(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
	} catch {
		return null;
	}
	if (process.platform === "darwin") {
		const ps = spawnSync("ps", [
			"-o",
			"command=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			timeout: 1e3
		});
		if (ps.error || ps.status !== 0) return null;
		const command = ps.stdout.trim();
		return command ? command.split(/\s+/) : null;
	}
	if (process.platform === "win32") return readWindowsProcessArgsSync(pid);
	return null;
}
function signalVerifiedGatewayPidSync(pid, signal) {
	const args = readGatewayProcessArgsSync(pid);
	if (!args || !isGatewayArgv(args, { allowGatewayBinary: true })) throw new Error(`refusing to signal non-gateway process pid ${pid}`);
	process.kill(pid, signal);
}
function findVerifiedGatewayListenerPidsOnPortSync(port) {
	const rawPids = process.platform === "win32" ? readWindowsListeningPidsOnPortSync(port) : findGatewayPidsOnPortSync(port);
	return Array.from(new Set(rawPids)).filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid).filter((pid) => {
		const args = readGatewayProcessArgsSync(pid);
		return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
	});
}
function formatGatewayPidList(pids) {
	return pids.join(", ");
}
//#endregion
export { signalVerifiedGatewayPidSync as i, formatGatewayPidList as n, readGatewayProcessArgsSync as r, findVerifiedGatewayListenerPidsOnPortSync as t };
