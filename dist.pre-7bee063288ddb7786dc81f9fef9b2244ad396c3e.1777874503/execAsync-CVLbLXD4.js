import { a as __require, t as __commonJSMin } from "./chunk-A-jGZS85.js";
//#region node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/execAsync.js
var require_execAsync = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.execAsync = void 0;
	const child_process = __require("child_process");
	exports.execAsync = __require("util").promisify(child_process.exec);
}));
//#endregion
export { require_execAsync as t };
