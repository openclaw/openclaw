/**
 * Agent Pack — shareable workspace templates for OpenClaw.
 */
export type {
  PackMetadata,
  PackEntry,
  PackInstallResult,
  PackInstallOptions,
  PackInitOptions,
  PackInitResult,
} from "./types.js";

export {
  parsePackFrontmatter,
  resolvePackMetadata,
  extractPackDescription,
} from "./frontmatter.js";
export { resolvePack, scanPacksDir } from "./resolve.js";
export { installPack } from "./install.js";
export { initPack } from "./init.js";
