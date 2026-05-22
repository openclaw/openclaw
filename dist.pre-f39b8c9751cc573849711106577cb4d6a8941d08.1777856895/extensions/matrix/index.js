import { t as defineBundledChannelEntry } from "../../channel-entry-contract-Dc3Ga3_x.js";
import { n as registerMatrixCliMetadata } from "../../cli-metadata-DqjsWq6D.js";
import { t as registerMatrixSubagentHooks } from "../../subagent-hooks-api-x6Zs2JXT.js";
//#region extensions/matrix/index.ts
let matrixHandlersRuntimePromise = null;
function loadMatrixHandlersRuntimeModule() {
	matrixHandlersRuntimePromise ??= import("./plugin-entry.handlers.runtime.js");
	return matrixHandlersRuntimePromise;
}
function registerMatrixFullRuntime(api) {
	api.registerGatewayMethod("matrix.verify.recoveryKey", async (ctx) => {
		const { handleVerifyRecoveryKey } = await loadMatrixHandlersRuntimeModule();
		await handleVerifyRecoveryKey(ctx);
	});
	api.registerGatewayMethod("matrix.verify.bootstrap", async (ctx) => {
		const { handleVerificationBootstrap } = await loadMatrixHandlersRuntimeModule();
		await handleVerificationBootstrap(ctx);
	});
	api.registerGatewayMethod("matrix.verify.status", async (ctx) => {
		const { handleVerificationStatus } = await loadMatrixHandlersRuntimeModule();
		await handleVerificationStatus(ctx);
	});
	registerMatrixSubagentHooks(api);
}
var matrix_default = defineBundledChannelEntry({
	id: "matrix",
	name: "Matrix",
	description: "Matrix channel plugin (matrix-js-sdk)",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "matrixPlugin"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	},
	runtime: {
		specifier: "./runtime-setter-api.js",
		exportName: "setMatrixRuntime"
	},
	registerCliMetadata: registerMatrixCliMetadata,
	registerFull: registerMatrixFullRuntime
});
//#endregion
export { matrix_default as default, registerMatrixFullRuntime };
