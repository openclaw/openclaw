import { format } from "node:util";
//#region src/plugin-sdk/runtime.ts
/** Adapt a simple logger into the RuntimeEnv contract used by shared plugin SDK helpers. */
function createLoggerBackedRuntime(params) {
	return {
		log: (...args) => {
			params.logger.info(format(...args));
		},
		error: (...args) => {
			params.logger.error(format(...args));
		},
		exit: (code) => {
			throw params.exitError?.(code) ?? /* @__PURE__ */ new Error(`exit ${code}`);
		}
	};
}
/** Reuse an existing runtime when present, otherwise synthesize one from the provided logger. */
function resolveRuntimeEnv(params) {
	return params.runtime ?? createLoggerBackedRuntime(params);
}
//#endregion
export { resolveRuntimeEnv as n, createLoggerBackedRuntime as t };
