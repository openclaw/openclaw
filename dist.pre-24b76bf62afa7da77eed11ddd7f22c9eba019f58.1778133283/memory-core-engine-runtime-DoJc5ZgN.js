import { t as createLazyFacadeObjectValue } from "./facade-loader-CEuC9fQG.js";
import { n as loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime-DYw_8ga8.js";
//#region src/plugin-sdk/memory-core-engine-runtime.ts
function loadFacadeModule() {
	return loadActivatedBundledPluginPublicSurfaceModuleSync({
		dirName: "memory-core",
		artifactBasename: "runtime-api.js"
	});
}
const auditShortTermPromotionArtifacts = ((...args) => loadFacadeModule()["auditShortTermPromotionArtifacts"](...args));
const auditDreamingArtifacts = ((...args) => loadFacadeModule()["auditDreamingArtifacts"](...args));
const getBuiltinMemoryEmbeddingProviderDoctorMetadata = ((...args) => loadFacadeModule()["getBuiltinMemoryEmbeddingProviderDoctorMetadata"](...args));
const getMemorySearchManager = ((...args) => loadFacadeModule()["getMemorySearchManager"](...args));
const listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata = ((...args) => loadFacadeModule()["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"](...args));
const MemoryIndexManager = createLazyFacadeObjectValue(() => loadFacadeModule()["MemoryIndexManager"]);
const repairShortTermPromotionArtifacts = ((...args) => loadFacadeModule()["repairShortTermPromotionArtifacts"](...args));
const repairDreamingArtifacts = ((...args) => loadFacadeModule()["repairDreamingArtifacts"](...args));
//#endregion
export { getMemorySearchManager as a, repairShortTermPromotionArtifacts as c, getBuiltinMemoryEmbeddingProviderDoctorMetadata as i, auditDreamingArtifacts as n, listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata as o, auditShortTermPromotionArtifacts as r, repairDreamingArtifacts as s, MemoryIndexManager as t };
