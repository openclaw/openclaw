import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as contributeGroqResolvedModelCompat } from "../../api-DXgCLjP0.js";
import { t as groqMediaUnderstandingProvider } from "../../media-understanding-provider-B8fhZs6b2.js";
//#region extensions/groq/index.ts
var groq_default = definePluginEntry({
	id: "groq",
	name: "Groq Provider",
	description: "Bundled Groq provider plugin",
	register(api) {
		api.registerProvider({
			id: "groq",
			label: "Groq",
			docsPath: "/providers/groq",
			envVars: ["GROQ_API_KEY"],
			auth: [],
			contributeResolvedModelCompat: ({ modelId, model }) => contributeGroqResolvedModelCompat({
				modelId,
				model
			})
		});
		api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
	}
});
//#endregion
export { groq_default as default };
