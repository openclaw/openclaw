//#region extensions/xai/provider-contract-api.ts
function createXaiProvider() {
	return {
		id: "xai",
		label: "xAI",
		aliases: ["x-ai"],
		docsPath: "/providers/xai",
		auth: [{
			id: "api-key",
			kind: "api_key",
			label: "xAI API key",
			hint: "API key",
			run: async () => ({ profiles: [] }),
			wizard: { groupLabel: "xAI (Grok)" }
		}]
	};
}
//#endregion
export { createXaiProvider };
