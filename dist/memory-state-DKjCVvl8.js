//#region src/plugins/memory-state.ts
const LEGACY_MEMORY_COMPAT_PLUGIN_ID = "legacy-memory-v1";
const memoryPluginState = {
	corpusSupplements: [],
	promptSupplements: []
};
function registerMemoryCorpusSupplement(pluginId, supplement) {
	const next = memoryPluginState.corpusSupplements.filter((registration) => registration.pluginId !== pluginId);
	next.push({
		pluginId,
		supplement
	});
	memoryPluginState.corpusSupplements = next;
}
function registerMemoryCapability(pluginId, capability) {
	memoryPluginState.capability = {
		pluginId,
		capability: { ...capability }
	};
}
function patchMemoryCapability(pluginId, patch) {
	registerMemoryCapability(pluginId, {
		...memoryPluginState.capability?.pluginId === pluginId ? memoryPluginState.capability.capability : {},
		...patch
	});
}
function getMemoryCapabilityRegistration() {
	return memoryPluginState.capability ? {
		pluginId: memoryPluginState.capability.pluginId,
		capability: { ...memoryPluginState.capability.capability }
	} : void 0;
}
function listMemoryCorpusSupplements() {
	return [...memoryPluginState.corpusSupplements];
}
/** @deprecated Use registerMemoryCapability(pluginId, { promptBuilder }) instead. */
function registerMemoryPromptSection(builder) {
	registerMemoryPromptSectionForPlugin(LEGACY_MEMORY_COMPAT_PLUGIN_ID, builder);
}
function registerMemoryPromptSectionForPlugin(pluginId, builder) {
	patchMemoryCapability(pluginId, { promptBuilder: builder });
}
function registerMemoryPromptSupplement(pluginId, builder) {
	const next = memoryPluginState.promptSupplements.filter((registration) => registration.pluginId !== pluginId);
	next.push({
		pluginId,
		builder
	});
	memoryPluginState.promptSupplements = next;
}
function buildMemoryPromptSection(params) {
	const primary = normalizeMemoryPromptLines(memoryPluginState.capability?.capability.promptBuilder?.(params) ?? []);
	const supplements = memoryPluginState.promptSupplements.toSorted((left, right) => left.pluginId.localeCompare(right.pluginId)).flatMap((registration) => normalizeMemoryPromptLines(registration.builder(params)));
	return [...primary, ...supplements];
}
function normalizeMemoryPromptLines(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((line) => typeof line === "string");
}
function getMemoryPromptSectionBuilder() {
	return memoryPluginState.capability?.capability.promptBuilder;
}
function listMemoryPromptSupplements() {
	return [...memoryPluginState.promptSupplements];
}
/** @deprecated Use registerMemoryCapability(pluginId, { flushPlanResolver }) instead. */
function registerMemoryFlushPlanResolver(resolver) {
	registerMemoryFlushPlanResolverForPlugin(LEGACY_MEMORY_COMPAT_PLUGIN_ID, resolver);
}
function registerMemoryFlushPlanResolverForPlugin(pluginId, resolver) {
	patchMemoryCapability(pluginId, { flushPlanResolver: resolver });
}
function resolveMemoryFlushPlan(params) {
	return memoryPluginState.capability?.capability.flushPlanResolver?.(params) ?? null;
}
function getMemoryFlushPlanResolver() {
	return memoryPluginState.capability?.capability.flushPlanResolver;
}
/** @deprecated Use registerMemoryCapability(pluginId, { runtime }) instead. */
function registerMemoryRuntime(runtime) {
	registerMemoryRuntimeForPlugin(LEGACY_MEMORY_COMPAT_PLUGIN_ID, runtime);
}
function registerMemoryRuntimeForPlugin(pluginId, runtime) {
	patchMemoryCapability(pluginId, { runtime });
}
function getMemoryRuntime() {
	return memoryPluginState.capability?.capability.runtime;
}
function hasMemoryRuntime() {
	return getMemoryRuntime() !== void 0;
}
function cloneMemoryPublicArtifact(artifact) {
	return {
		...artifact,
		agentIds: [...artifact.agentIds]
	};
}
async function listActiveMemoryPublicArtifacts(params) {
	return (await memoryPluginState.capability?.capability.publicArtifacts?.listArtifacts(params) ?? []).map(cloneMemoryPublicArtifact).toSorted((left, right) => {
		const workspaceOrder = left.workspaceDir.localeCompare(right.workspaceDir);
		if (workspaceOrder !== 0) return workspaceOrder;
		const relativePathOrder = left.relativePath.localeCompare(right.relativePath);
		if (relativePathOrder !== 0) return relativePathOrder;
		const kindOrder = left.kind.localeCompare(right.kind);
		if (kindOrder !== 0) return kindOrder;
		const contentTypeOrder = left.contentType.localeCompare(right.contentType);
		if (contentTypeOrder !== 0) return contentTypeOrder;
		const agentOrder = left.agentIds.join("\0").localeCompare(right.agentIds.join("\0"));
		if (agentOrder !== 0) return agentOrder;
		return left.absolutePath.localeCompare(right.absolutePath);
	});
}
function restoreMemoryPluginState(state) {
	memoryPluginState.capability = state.capability ? {
		pluginId: state.capability.pluginId,
		capability: { ...state.capability.capability }
	} : void 0;
	memoryPluginState.corpusSupplements = [...state.corpusSupplements];
	memoryPluginState.promptSupplements = [...state.promptSupplements];
}
function clearMemoryPluginState() {
	memoryPluginState.capability = void 0;
	memoryPluginState.corpusSupplements = [];
	memoryPluginState.promptSupplements = [];
}
const resetMemoryPluginState = clearMemoryPluginState;
//#endregion
export { restoreMemoryPluginState as S, registerMemoryPromptSupplement as _, getMemoryPromptSectionBuilder as a, resetMemoryPluginState as b, listActiveMemoryPublicArtifacts as c, registerMemoryCapability as d, registerMemoryCorpusSupplement as f, registerMemoryPromptSectionForPlugin as g, registerMemoryPromptSection as h, getMemoryFlushPlanResolver as i, listMemoryCorpusSupplements as l, registerMemoryFlushPlanResolverForPlugin as m, clearMemoryPluginState as n, getMemoryRuntime as o, registerMemoryFlushPlanResolver as p, getMemoryCapabilityRegistration as r, hasMemoryRuntime as s, buildMemoryPromptSection as t, listMemoryPromptSupplements as u, registerMemoryRuntime as v, resolveMemoryFlushPlan as x, registerMemoryRuntimeForPlugin as y };
