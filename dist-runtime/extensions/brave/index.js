import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../external-content-CxoN_TKD.js";
import "../../mime-33LCeGh-.js";
import { a as setTopLevelCredentialValue, r as getTopLevelCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-CeUlA68v.js";
//#region extensions/brave/index.ts
const bravePlugin = {
	id: "brave",
	name: "Brave Plugin",
	description: "Bundled Brave plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerWebSearchProvider(createPluginBackedWebSearchProvider({
			id: "brave",
			label: "Brave Search",
			hint: "Structured results · country/language/time filters",
			envVars: ["BRAVE_API_KEY"],
			placeholder: "BSA...",
			signupUrl: "https://brave.com/search/api/",
			docsUrl: "https://docs.openclaw.ai/brave-search",
			autoDetectOrder: 10,
			getCredentialValue: getTopLevelCredentialValue,
			setCredentialValue: setTopLevelCredentialValue
		}));
	}
};
//#endregion
export { bravePlugin as default };
