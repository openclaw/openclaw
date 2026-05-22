import { Type } from "typebox";
//#region extensions/xai/x-search-tool-shared.ts
function buildMissingXSearchApiKeyPayload() {
	return {
		error: "missing_xai_api_key",
		message: "x_search needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
}
function createXSearchToolDefinition(execute) {
	return {
		label: "X Search",
		name: "x_search",
		description: "Search X (formerly Twitter) using xAI, including targeted post or thread lookups. For per-post stats like reposts, replies, bookmarks, or views, prefer the exact post URL or status ID.",
		parameters: Type.Object({
			query: Type.String({ description: "X search query string." }),
			allowed_x_handles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Only include posts from these X handles." })),
			excluded_x_handles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Exclude posts from these X handles." })),
			from_date: Type.Optional(Type.String({ description: "Only include posts on or after this date (YYYY-MM-DD)." })),
			to_date: Type.Optional(Type.String({ description: "Only include posts on or before this date (YYYY-MM-DD)." })),
			enable_image_understanding: Type.Optional(Type.Boolean({ description: "Allow xAI to inspect images attached to matching posts." })),
			enable_video_understanding: Type.Optional(Type.Boolean({ description: "Allow xAI to inspect videos attached to matching posts." }))
		}),
		execute
	};
}
//#endregion
export { createXSearchToolDefinition as n, buildMissingXSearchApiKeyPayload as t };
