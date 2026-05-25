/**
 * @claworks/runtime — public barrel for ClaWorks core.
 *
 * OpenClaw-specific glue (createClaworksBridge) stays in extensions/claworks-robot.
 */

export * from "./claworks/index.js";
export { registerClaworksPacksCli } from "./claworks/packs-cli.js";
export { registerClaworksInitCli } from "./claworks/init-cli.js";

export {
  createIngressRouter,
  DEFAULT_INGRESS_POLICIES,
  type IngressRouter,
  type IngressSource,
  type IngressDecision,
  type IngressPolicy,
} from "./kernel/ingress.js";

export * from "./planes/data/index.js";
export * from "./planes/orch/index.js";
export * from "./interfaces/index.js";

export type { KnowledgeBase, KbResult, RobotInfo } from "./kernel/types.js";

export {
  SystemPromptBuilder,
  createBasePromptBuilder,
  PROMPT_PRIORITY,
  type PromptSection,
  type PromptSectionPriority,
} from "./kernel/system-prompt-builder.js";

export {
  createPackLoader,
  resolvePackDir,
  resolveInstalledPackIds,
  readPackManifestFromDir,
  parsePlaybookYaml,
  parseObjectTypeYaml,
  readPackManifest,
  installPackFromNexus,
  listNexusPackages,
  parseNexusSource,
  type PackLoader,
  type CwPackConfig,
  type LoadedPack,
  type PackManifest,
  type NexusInstallSpec,
} from "./pack-loader/index.js";

export type {
  PackContribution,
  PackFactory,
  PackSdkContext,
  HookDefinition,
} from "./pack-loader/pack-sdk.js";

export type { CapabilityDescriptor, CapabilityContext } from "./kernel/capability-registry.js";
export type {
  ActionRegistry,
  ActionHandler,
  ActionRegistration,
} from "./kernel/action-registry.js";
export type { IntentRegistry, IntentMapping } from "./kernel/intent-registry.js";
export { CW_EVENTS, type CwEventType } from "./kernel/event-names.js";

export {
  buildTraceDiagnostic,
  recordEventTraceDiagnostic,
  CLAWORKS_TRACE_OBSERVATION_TYPE,
  type ClaworksTraceDiagnostic,
} from "./kernel/trace-diagnostics.js";

export {
  discoverPackSourceDir,
  hasPackSourcesAvailable,
  isClaworksRobotConfigPresent,
  repairClaworksJsonConfig,
  repairOtConnectorSimulateFlags,
  type ProductConfigRepairResult,
} from "./claworks/product-config-repair.js";
