import "./provider-env-vars-BfZUtZAn.js";
import "./resolve-route-BZ4hHpx2.js";
import "./logger-CRwcgB9y.js";
import "./tmp-openclaw-dir-Bz3ouN_i.js";
import "./paths-Byjx7_T6.js";
import "./subsystem-CsP80x3t.js";
import "./utils-o1tyfnZ_.js";
import "./fetch-Dx857jUp.js";
import "./retry-BY_ggjbn.js";
import "./agent-scope-DV_aCIyi.js";
import "./exec-BLi45_38.js";
import "./logger-Bsnck4bK.js";
import "./paths-OqPpu-UR.js";
import { Kl as normalizeApiKeyInput, Vl as ensureApiKeyFromOptionEnvOrPrompt, ql as validateApiKeyInput } from "./auth-profiles-CuJtivJK.js";
import "./profiles-CV7WLKIX.js";
import "./fetch-D2ZOzaXt.js";
import "./external-content-vZzOHxnd.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-l-LpSxGW.js";
import "./pairing-token-DKpN4qO0.js";
import "./query-expansion-txqQdNIf.js";
import "./redact-BefI-5cC.js";
import "./mime-33LCeGh-.js";
import "./typebox-BmZP6XXv.js";
import "./web-search-plugin-factory-DStYVW2B.js";
import { E as buildApiKeyCredential } from "./onboard-auth.config-core-RGiehkaJ.js";
import "./onboard-auth.models-DgQQVW6a.js";
import { t as applyAuthProfileConfig } from "./auth-profile-config-Dyrd8Od7.js";
import "./onboard-auth.config-minimax-CHFiQ6wX.js";
import "./onboard-auth.config-opencode-BJ8anUQU.js";
import "./onboard-auth-DCHJrlNU.js";
import "./shared-Docrh07K.js";
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
