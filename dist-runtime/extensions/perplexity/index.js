import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../external-content-CxoN_TKD.js";
import "../../mime-33LCeGh-.js";
import { i as setScopedCredentialValue, n as getScopedCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-CeUlA68v.js";
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
