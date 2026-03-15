import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../external-content-vZzOHxnd.js";
import "../../mime-33LCeGh-.js";
import { a as setTopLevelCredentialValue, r as getTopLevelCredentialValue, t as createPluginBackedWebSearchProvider } from "../../web-search-plugin-factory-DStYVW2B.js";
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
