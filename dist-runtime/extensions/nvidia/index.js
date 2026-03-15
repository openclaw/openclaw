import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../core-qWFcsWSH.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { m as buildNvidiaProvider } from "../../models-config.providers.static-DRBnLpDj.js";
//#region extensions/nvidia/index.ts
const PROVIDER_ID = "nvidia";
const nvidiaPlugin = {
	id: PROVIDER_ID,
	name: "NVIDIA Provider",
	description: "Bundled NVIDIA provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "NVIDIA",
			docsPath: "/providers/nvidia",
			envVars: ["NVIDIA_API_KEY"],
			auth: [],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...buildNvidiaProvider(),
						apiKey
					} };
				}
			}
		});
	}
};
//#endregion
export { nvidiaPlugin as default };
