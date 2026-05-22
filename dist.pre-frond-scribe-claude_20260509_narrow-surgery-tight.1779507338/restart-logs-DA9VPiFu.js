import { d as resolveGatewayProfileSuffix } from "./constants-CmvvKVqh.js";
import { n as resolveHomeDir, t as resolveGatewayStateDir } from "./paths-Bq0Y-b28.js";
import { n as quoteCmdScriptArg } from "./cmd-argv-fj4pRVR6.js";
import path from "node:path";
//#region src/daemon/restart-logs.ts
const GATEWAY_RESTART_LOG_FILENAME = "gateway-restart.log";
function resolveGatewayLogPrefix(env) {
	return env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
}
function resolveMacLaunchAgentLogPrefix(env) {
	return env.OPENCLAW_LOG_PREFIX?.trim() || `gateway${resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE)}`;
}
function resolveGatewayLogPaths(env) {
	const stateDir = resolveGatewayStateDir(env);
	const logDir = path.join(stateDir, "logs");
	const prefix = resolveGatewayLogPrefix(env);
	return {
		logDir,
		stdoutPath: path.join(logDir, `${prefix}.log`),
		stderrPath: path.join(logDir, `${prefix}.err.log`)
	};
}
function resolveMacLaunchAgentLogPaths(env) {
	const home = resolveHomeDir(env).replaceAll("\\", "/");
	const logDir = path.posix.join(home, "Library", "Logs", "openclaw");
	const prefix = resolveMacLaunchAgentLogPrefix(env);
	return {
		logDir,
		stdoutPath: path.posix.join(logDir, `${prefix}.log`),
		stderrPath: path.posix.join(logDir, `${prefix}.err.log`)
	};
}
function resolveGatewaySupervisorLogPaths(env, options) {
	return (options?.platform ?? process.platform) === "darwin" ? resolveMacLaunchAgentLogPaths(env) : resolveGatewayLogPaths(env);
}
function resolveGatewayRestartLogPath(env) {
	return path.join(resolveGatewayLogPaths(env).logDir, GATEWAY_RESTART_LOG_FILENAME);
}
function shellEscapeRestartLogValue(value) {
	return value.replace(/'/g, "'\\''");
}
function renderPosixRestartLogSetup(env) {
	const logDir = path.dirname(resolveGatewayRestartLogPath(env));
	const logPath = resolveGatewayRestartLogPath(env);
	const escapedLogDir = shellEscapeRestartLogValue(logDir);
	const escapedLogPath = shellEscapeRestartLogValue(logPath);
	return `if mkdir -p '${escapedLogDir}' 2>/dev/null && : >>'${escapedLogPath}' 2>/dev/null; then
  exec >>'${escapedLogPath}' 2>&1
fi`;
}
function renderCmdRestartLogSetup(env) {
	const logPath = resolveGatewayRestartLogPath(env);
	const quotedLogDir = quoteCmdScriptArg(path.dirname(logPath));
	const quotedLogPath = quoteCmdScriptArg(logPath);
	return {
		quotedLogPath,
		lines: [`if not exist ${quotedLogDir} mkdir ${quotedLogDir} >nul 2>&1`, `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart log initialized`]
	};
}
//#endregion
export { resolveGatewaySupervisorLogPaths as a, resolveGatewayRestartLogPath as i, renderPosixRestartLogSetup as n, shellEscapeRestartLogValue as o, resolveGatewayLogPaths as r, renderCmdRestartLogSetup as t };
