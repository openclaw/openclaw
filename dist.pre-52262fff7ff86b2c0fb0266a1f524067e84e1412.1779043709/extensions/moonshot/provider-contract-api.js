//#region extensions/moonshot/provider-contract-api.ts
const noopAuth = async () => ({ profiles: [] });
function createMoonshotProvider() {
	return {
		id: "moonshot",
		label: "Moonshot",
		docsPath: "/providers/moonshot",
		auth: [{
			id: "api-key",
			kind: "api_key",
			label: "Kimi API key (.ai)",
			hint: "Kimi K2.6 + Kimi",
			run: noopAuth,
			wizard: { groupLabel: "Moonshot AI (Kimi K2.6)" }
		}, {
			id: "api-key-cn",
			kind: "api_key",
			label: "Kimi API key (.cn)",
			hint: "Kimi K2.6 + Kimi",
			run: noopAuth,
			wizard: { groupLabel: "Moonshot AI (Kimi K2.6)" }
		}]
	};
}
//#endregion
export { createMoonshotProvider };
