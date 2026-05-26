//#region extensions/gradium/shared.ts
const DEFAULT_GRADIUM_BASE_URL = "https://api.gradium.ai";
const DEFAULT_GRADIUM_VOICE_ID = "YTpq7expH9539ERJ";
const GRADIUM_VOICES = [
	{
		id: "YTpq7expH9539ERJ",
		name: "Emma"
	},
	{
		id: "LFZvm12tW_z0xfGo",
		name: "Kent"
	},
	{
		id: "Eu9iL_CYe8N-Gkx_",
		name: "Tiffany"
	},
	{
		id: "2H4HY2CBNyJHBCrP",
		name: "Christina"
	},
	{
		id: "jtEKaLYNn6iif5PR",
		name: "Sydney"
	},
	{
		id: "KWJiFWu2O9nMPYcR",
		name: "John"
	},
	{
		id: "3jUdJyOi9pgbxBTK",
		name: "Arthur"
	}
];
function normalizeGradiumBaseUrl(baseUrl) {
	return (baseUrl?.trim())?.replace(/\/+$/, "") || DEFAULT_GRADIUM_BASE_URL;
}
//#endregion
export { GRADIUM_VOICES as n, normalizeGradiumBaseUrl as r, DEFAULT_GRADIUM_VOICE_ID as t };
