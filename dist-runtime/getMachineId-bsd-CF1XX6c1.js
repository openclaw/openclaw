import { a as __toCommonJS, i as __require, t as __commonJSMin } from "./chunk-DORXReHP.js";
import { n as init_esm, t as esm_exports } from "./esm-DweMoRD1.js";
import { t as require_execAsync } from "./execAsync-CIwUtv5p.js";
//#region node_modules/.pnpm/@opentelemetry+resources@2.6.0_@opentelemetry+api@1.9.0/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-bsd.js
var require_getMachineId_bsd = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getMachineId = void 0;
	const fs_1 = __require("fs");
	const execAsync_1 = require_execAsync();
	const api_1 = (init_esm(), __toCommonJS(esm_exports));
	async function getMachineId() {
		try {
			return (await fs_1.promises.readFile("/etc/hostid", { encoding: "utf8" })).trim();
		} catch (e) {
			api_1.diag.debug(`error reading machine id: ${e}`);
		}
		try {
			return (await (0, execAsync_1.execAsync)("kenv -q smbios.system.uuid")).stdout.trim();
		} catch (e) {
			api_1.diag.debug(`error reading machine id: ${e}`);
		}
	}
	exports.getMachineId = getMachineId;
}));
//#endregion
export default require_getMachineId_bsd();

