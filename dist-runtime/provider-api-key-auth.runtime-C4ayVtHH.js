import "./provider-env-vars-BfZUtZAn.js";
import "./resolve-route-CQsiaDZO.js";
import "./logger-BOdgfoqz.js";
import "./tmp-openclaw-dir-DgEKZnX6.js";
import "./paths-CbmqEZIn.js";
import "./subsystem-CsPxmH8p.js";
import "./utils-CMc9mmF8.js";
import "./fetch-BgkAjqxB.js";
import "./retry-CgLvWye-.js";
import "./agent-scope-CM8plEdu.js";
import "./exec-CWMR162-.js";
import "./logger-C833gw0R.js";
import "./paths-DAoqckDF.js";
import { Ju as normalizeApiKeyInput, Uu as ensureApiKeyFromOptionEnvOrPrompt, Yu as validateApiKeyInput } from "./auth-profiles-B70DPAVa.js";
import "./profiles-BC4VpDll.js";
import "./fetch-BX2RRCzB.js";
import "./external-content-CxoN_TKD.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-gVOHvGnm.js";
import "./pairing-token-Do-E3rL5.js";
import "./query-expansion-Do6vyPvH.js";
import "./redact-BZcL_gJG.js";
import "./mime-33LCeGh-.js";
import "./typebox-B4kR5eyM.js";
import "./web-search-plugin-factory-CeUlA68v.js";
import { E as buildApiKeyCredential } from "./onboard-auth.config-core-C8O7u8CI.js";
import "./onboard-auth.models-DU-07n1Q.js";
import { t as applyAuthProfileConfig } from "./auth-profile-config-llBi0KHf.js";
import "./onboard-auth.config-minimax-BZLhwFh4.js";
import "./onboard-auth.config-opencode-CPtsorYE.js";
import "./onboard-auth-D_nBXMz2.js";
import "./shared-0J96S80B.js";
//#region src/commands/model-picker.ts
function applyPrimaryModel(cfg, model) {
	const defaults = cfg.agents?.defaults;
	const existingModel = defaults?.model;
	const existingModels = defaults?.models;
	const fallbacks = typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel ? existingModel.fallbacks : void 0;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				model: {
					...fallbacks ? { fallbacks } : void 0,
					primary: model
				},
				models: {
					...existingModels,
					[model]: existingModels?.[model] ?? {}
				}
			}
		}
	};
}
//#endregion
export { applyAuthProfileConfig, applyPrimaryModel, buildApiKeyCredential, ensureApiKeyFromOptionEnvOrPrompt, normalizeApiKeyInput, validateApiKeyInput };
