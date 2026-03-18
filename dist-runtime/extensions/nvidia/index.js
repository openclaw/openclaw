import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../core-CUbPSeQH.js";
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
