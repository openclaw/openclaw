import { t as resolveGatewayStateDir } from "./paths-CBMC-f_X.js";
import { n as quoteCmdScriptArg } from "./cmd-argv-DexenlHS.js";
import path from "node:path";
//#region src/daemon/restart-logs.ts
const GATEWAY_RESTART_LOG_FILENAME = "gateway-restart.log";
function resolveGatewayLogPaths(env) {
	const stateDir = resolveGatewayStateDir(env);
	const logDir = path.join(stateDir, "logs");
	const prefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";
	return {
		logDir,
		stdoutPath: path.join(logDir, `${prefix}.log`),
		stderrPath: path.join(logDir, `${prefix}.err.log`)
	};
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
export { shellEscapeRestartLogValue as a, resolveGatewayRestartLogPath as i, renderPosixRestartLogSetup as n, resolveGatewayLogPaths as r, renderCmdRestartLogSetup as t };
