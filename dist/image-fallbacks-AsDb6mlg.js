import { i as removeFallbackCommand, n as clearFallbacksCommand, r as listFallbacksCommand, t as addFallbackCommand } from "./fallbacks-shared-BXkY5MMH.js";
//#region src/commands/models/image-fallbacks.ts
async function modelsImageFallbacksListCommand(opts, runtime) {
	return await listFallbacksCommand({
		label: "Image fallbacks",
		key: "imageModel"
	}, opts, runtime);
}
async function modelsImageFallbacksAddCommand(modelRaw, runtime) {
	return await addFallbackCommand({
		label: "Image fallbacks",
		key: "imageModel",
		logPrefix: "Image fallbacks"
	}, modelRaw, runtime);
}
async function modelsImageFallbacksRemoveCommand(modelRaw, runtime) {
	return await removeFallbackCommand({
		label: "Image fallbacks",
		key: "imageModel",
		notFoundLabel: "Image fallback",
		logPrefix: "Image fallbacks"
	}, modelRaw, runtime);
}
async function modelsImageFallbacksClearCommand(runtime) {
	return await clearFallbacksCommand({
		key: "imageModel",
		clearedMessage: "Image fallback list cleared."
	}, runtime);
}
//#endregion
export { modelsImageFallbacksAddCommand, modelsImageFallbacksClearCommand, modelsImageFallbacksListCommand, modelsImageFallbacksRemoveCommand };
