import { u as resolveXaiCatalogEntry } from "./model-definitions-Bl-c2P5x.js";
//#region extensions/xai/provider-policy-api.ts
function resolveThinkingProfile(ctx) {
	const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(ctx.modelId)?.reasoning;
	if (ctx.provider !== "xai" || !reasoning) return {
		levels: [{ id: "off" }],
		defaultLevel: "off"
	};
	return {
		levels: [
			{ id: "off" },
			{ id: "minimal" },
			{ id: "low" },
			{ id: "medium" },
			{ id: "high" }
		],
		defaultLevel: "low"
	};
}
//#endregion
export { resolveThinkingProfile as t };
