import { streamAnthropic } from "@mariozechner/pi-ai";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { StreamFn } from "@mariozechner/pi-agent-core";

//#region extensions/anthropic-vertex/stream-runtime.d.ts
type AnthropicVertexClientOptions = ConstructorParameters<typeof AnthropicVertex>[0];
type AnthropicVertexStreamDeps = {
  AnthropicVertex: new (options: AnthropicVertexClientOptions) => unknown;
  streamAnthropic: typeof streamAnthropic;
};
/**
 * Create a StreamFn that routes through pi-ai's `streamAnthropic` with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by pi-ai — we only supply the GCP-authenticated
 * client and map SimpleStreamOptions → AnthropicOptions.
 */
declare function createAnthropicVertexStreamFn(projectId: string | undefined, region: string, baseURL?: string, deps?: AnthropicVertexStreamDeps): StreamFn;
declare function createAnthropicVertexStreamFnForModel(model: {
  baseUrl?: string;
}, env?: NodeJS.ProcessEnv, deps?: AnthropicVertexStreamDeps): StreamFn;
//#endregion
export { createAnthropicVertexStreamFn as n, createAnthropicVertexStreamFnForModel as r, AnthropicVertexStreamDeps as t };