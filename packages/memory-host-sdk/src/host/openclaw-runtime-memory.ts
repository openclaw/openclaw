// Memory-facing runtime facade for plugin registration, embeddings, and prompt artifacts.
// Re-export only stable host seams; plugin implementations should not import core internals.
export { emptyPluginConfigSchema } from "../../../../src/plugins/config-schema.js";
export {
  buildMemoryPromptSection as buildActiveMemoryPromptSection,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
} from "../../../../src/plugins/memory-state.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "../../../../src/plugins/memory-state.js";
export type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
