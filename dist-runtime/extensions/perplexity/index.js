import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../external-content-vZzOHxnd.js";
import "../../mime-33LCeGh-.js";
import { i as setScopedCredentialValue, n as getScopedCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-DStYVW2B.js";
//#region extensions/perplexity/index.ts
const perplexityPlugin = {
	id: "perplexity",
	name: "Perplexity Plugin",
	description: "Bundled Perplexity plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerWebSearchProvider(createPluginBackedWebSearchProvider({
			id: "perplexity",
			label: "Perplexity Search",
			hint: "Structured results · domain/country/language/time filters",
			envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
			placeholder: "pplx-...",
			signupUrl: "https://www.perplexity.ai/settings/api",
			docsUrl: "https://docs.openclaw.ai/perplexity",
			autoDetectOrder: 50,
			getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "perplexity"),
			setCredentialValue: (searchConfigTarget, value) => setScopedCredentialValue(searchConfigTarget, "perplexity", value)
		}));
	}
};
//#endregion
export { perplexityPlugin as default };
