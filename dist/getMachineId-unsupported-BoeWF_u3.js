import { a as __toCommonJS, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { n as init_esm, t as esm_exports } from "./esm-DKEI1YUj.js";
//#region node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-unsupported.js
var require_getMachineId_unsupported = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getMachineId = void 0;
	const api_1 = (init_esm(), __toCommonJS(esm_exports));
	async function getMachineId() {
		api_1.diag.debug("could not read machine-id: unsupported platform");
	}
	exports.getMachineId = getMachineId;
}));
//#endregion
export default require_getMachineId_unsupported();
export {};
