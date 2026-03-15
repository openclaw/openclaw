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
//#region extensions/amazon-bedrock/index.ts
const PROVIDER_ID = "amazon-bedrock";
const CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;
const amazonBedrockPlugin = {
	id: PROVIDER_ID,
	name: "Amazon Bedrock Provider",
	description: "Bundled Amazon Bedrock provider policy plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "Amazon Bedrock",
			docsPath: "/providers/models",
			auth: [],
			resolveDefaultThinkingLevel: ({ modelId }) => CLAUDE_46_MODEL_RE.test(modelId.trim()) ? "adaptive" : void 0
		});
	}
};
//#endregion
export { amazonBedrockPlugin as default };
