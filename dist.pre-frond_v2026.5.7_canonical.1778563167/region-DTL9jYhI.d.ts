//#region extensions/anthropic-vertex/region.d.ts
declare function resolveAnthropicVertexRegion(env?: NodeJS.ProcessEnv): string;
declare function resolveAnthropicVertexProjectId(env?: NodeJS.ProcessEnv): string | undefined;
declare function resolveAnthropicVertexRegionFromBaseUrl(baseUrl?: string): string | undefined;
declare function resolveAnthropicVertexClientRegion(params?: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): string;
declare function hasAnthropicVertexCredentials(env?: NodeJS.ProcessEnv): boolean;
declare function hasAnthropicVertexAvailableAuth(env?: NodeJS.ProcessEnv): boolean;
declare function resolveAnthropicVertexConfigApiKey(env?: NodeJS.ProcessEnv): string | undefined;
//#endregion
export { resolveAnthropicVertexProjectId as a, resolveAnthropicVertexConfigApiKey as i, hasAnthropicVertexCredentials as n, resolveAnthropicVertexRegion as o, resolveAnthropicVertexClientRegion as r, resolveAnthropicVertexRegionFromBaseUrl as s, hasAnthropicVertexAvailableAuth as t };