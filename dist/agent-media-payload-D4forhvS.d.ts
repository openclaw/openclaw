import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region src/media/local-roots.d.ts
type BuildMediaLocalRootsOptions = {
  preferredTmpDir?: string;
};
declare function buildMediaLocalRoots(stateDir: string, configDir: string, options?: BuildMediaLocalRootsOptions): string[];
declare function getDefaultMediaLocalRoots(): readonly string[];
declare function getAgentScopedMediaLocalRoots(cfg: OpenClawConfig, agentId?: string): readonly string[];
declare function appendLocalMediaParentRoots(roots: readonly string[], mediaSources?: readonly string[]): string[];
declare function getAgentScopedMediaLocalRootsForSources(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaSources?: readonly string[];
}): readonly string[];
//#endregion
//#region src/plugin-sdk/agent-media-payload.d.ts
type AgentMediaPayload = {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};
/** Convert outbound media descriptors into the legacy agent payload field layout. */
declare function buildAgentMediaPayload(mediaList: Array<{
  path: string;
  contentType?: string | null;
}>): AgentMediaPayload;
//#endregion
export { getAgentScopedMediaLocalRoots as a, buildMediaLocalRoots as i, buildAgentMediaPayload as n, getAgentScopedMediaLocalRootsForSources as o, appendLocalMediaParentRoots as r, getDefaultMediaLocalRoots as s, AgentMediaPayload as t };