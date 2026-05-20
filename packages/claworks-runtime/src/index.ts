/**
 * @claworks/runtime — public barrel for ClaWorks core.
 *
 * OpenClaw-specific glue (createClaworksBridge) stays in extensions/claworks-robot.
 */

export * from "./claworks/index.js";
export { registerClaworksPacksCli } from "./claworks/packs-cli.js";

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
  createPackLoader,
  resolvePackDir,
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
