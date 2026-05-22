import { r as loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader-CEuC9fQG.js";
//#region src/plugin-sdk/memory-core-bundled-runtime.ts
function loadApiFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "memory-core",
		artifactBasename: "api.js"
	});
}
function loadRuntimeFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "memory-core",
		artifactBasename: "runtime-api.js"
	});
}
const createEmbeddingProvider = ((...args) => loadRuntimeFacadeModule().createEmbeddingProvider(...args));
const registerBuiltInMemoryEmbeddingProviders = ((...args) => loadRuntimeFacadeModule().registerBuiltInMemoryEmbeddingProviders(...args));
const removeGroundedShortTermCandidates = ((...args) => loadRuntimeFacadeModule().removeGroundedShortTermCandidates(...args));
const repairDreamingArtifacts = ((...args) => loadRuntimeFacadeModule().repairDreamingArtifacts(...args));
const previewGroundedRemMarkdown = ((...args) => loadApiFacadeModule().previewGroundedRemMarkdown(...args));
const dedupeDreamDiaryEntries = ((...args) => loadApiFacadeModule().dedupeDreamDiaryEntries(...args));
const writeBackfillDiaryEntries = ((...args) => loadApiFacadeModule().writeBackfillDiaryEntries(...args));
const removeBackfillDiaryEntries = ((...args) => loadApiFacadeModule().removeBackfillDiaryEntries(...args));
const previewRemHarness = ((...args) => loadApiFacadeModule().previewRemHarness(...args));
//#endregion
export { registerBuiltInMemoryEmbeddingProviders as a, repairDreamingArtifacts as c, previewRemHarness as i, writeBackfillDiaryEntries as l, dedupeDreamDiaryEntries as n, removeBackfillDiaryEntries as o, previewGroundedRemMarkdown as r, removeGroundedShortTermCandidates as s, createEmbeddingProvider as t };
