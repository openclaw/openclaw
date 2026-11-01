import type { StreamFn } from "@openclaw/llm-core";
/**
 * Anthropic Vertex stream facade.
 * Keeps Vertex-specific provider implementation in the bundled provider plugin
 * while core imports a small stable factory.
 */
import { loadBundledPluginPublicSurfaceModuleSync } from "../plugin-sdk/facade-runtime.js";

/** Creates an Anthropic Vertex stream function through the bundled provider facade. */
export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  return loadBundledPluginPublicSurfaceModuleSync<{
    createAnthropicVertexStreamFnForModel: (
      model: { baseUrl?: string },
      env?: NodeJS.ProcessEnv,
    ) => StreamFn;
  }>({
    dirName: "anthropic-vertex",
    artifactBasename: "api.js",
  }).createAnthropicVertexStreamFnForModel(model, env);
}
