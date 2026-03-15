import "../../provider-env-vars-BfZUtZAn.js";
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
import "../../paths-OqPpu-UR.js";
import "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import { o as buildVercelAiGatewayProvider } from "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { C as VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF, y as applyVercelAiGatewayConfig } from "../../onboard-auth.config-core-RGiehkaJ.js";
import "../../onboard-auth.models-DgQQVW6a.js";
import "../../onboard-auth.config-minimax-CHFiQ6wX.js";
import "../../onboard-auth.config-opencode-BJ8anUQU.js";
import "../../onboard-auth-DCHJrlNU.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-C_oZ2YEn.js";
//#region extensions/vercel-ai-gateway/index.ts
const PROVIDER_ID = "vercel-ai-gateway";
const vercelAiGatewayPlugin = {
	id: PROVIDER_ID,
	name: "Vercel AI Gateway Provider",
	description: "Bundled Vercel AI Gateway provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Vercel AI Gateway",
			docsPath: "/providers/vercel-ai-gateway",
			envVars: ["AI_GATEWAY_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "Vercel AI Gateway API key",
				hint: "API key",
				optionKey: "aiGatewayApiKey",
				flagName: "--ai-gateway-api-key",
				envVar: "AI_GATEWAY_API_KEY",
				promptMessage: "Enter Vercel AI Gateway API key",
				defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
				expectedProviders: ["vercel-ai-gateway"],
				applyConfig: (cfg) => applyVercelAiGatewayConfig(cfg),
				wizard: {
					choiceId: "ai-gateway-api-key",
					choiceLabel: "Vercel AI Gateway API key",
					groupId: "ai-gateway",
					groupLabel: "Vercel AI Gateway",
					groupHint: "API key"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...await buildVercelAiGatewayProvider(),
						apiKey
					} };
				}
			}
		});
	}
};
//#endregion
export { vercelAiGatewayPlugin as default };
