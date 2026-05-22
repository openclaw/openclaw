import { format } from "node:util";
//#region src/plugin-sdk/runtime-logger.ts
/** Adapt a simple logger into the RuntimeEnv contract used by shared plugin SDK helpers. */
function createLoggerBackedRuntime(params) {
	return {
		log: (...args) => {
			params.logger.info(format(...args));
		},
		error: (...args) => {
			params.logger.error(format(...args));
		},
		writeStdout: (value) => {
			params.logger.info(value);
		},
		writeJson: (value, space = 2) => {
			params.logger.info(JSON.stringify(value, null, space > 0 ? space : void 0));
		},
		exit: (code) => {
			throw params.exitError?.(code) ?? /* @__PURE__ */ new Error(`exit ${code}`);
		}
	};
}
function resolveRuntimeEnv(params) {
	return params.runtime ?? createLoggerBackedRuntime(params);
}
function resolveRuntimeEnvWithUnavailableExit(params) {
	if (params.runtime) return resolveRuntimeEnv({
		runtime: params.runtime,
		logger: params.logger,
		exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available")
	});
	return resolveRuntimeEnv({
		logger: params.logger,
		exitError: () => new Error(params.unavailableMessage ?? "Runtime exit not available")
	});
}
//#endregion
export { resolveRuntimeEnv as n, resolveRuntimeEnvWithUnavailableExit as r, createLoggerBackedRuntime as t };
