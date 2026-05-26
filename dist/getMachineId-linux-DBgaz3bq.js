import { a as __toCommonJS, i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { n as init_esm, t as esm_exports } from "./esm-DKEI1YUj.js";
//#region node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-linux.js
var require_getMachineId_linux = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getMachineId = void 0;
	const fs_1 = __require("fs");
	const api_1 = (init_esm(), __toCommonJS(esm_exports));
	async function getMachineId() {
		for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) try {
			return (await fs_1.promises.readFile(path, { encoding: "utf8" })).trim();
		} catch (e) {
			api_1.diag.debug(`error reading machine id: ${e}`);
		}
	}
	exports.getMachineId = getMachineId;
}));
//#endregion
export default require_getMachineId_linux();
export {};
