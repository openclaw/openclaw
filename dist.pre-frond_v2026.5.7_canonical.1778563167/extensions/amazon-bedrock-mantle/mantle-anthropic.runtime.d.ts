import Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/amazon-bedrock-mantle/mantle-anthropic.runtime.d.ts
type AnthropicOptions = ConstructorParameters<typeof Anthropic>[0];
declare function resolveMantleAnthropicBaseUrl(baseUrl: string): string;
declare function createMantleAnthropicStreamFn(deps?: {
  createClient?: (options: AnthropicOptions) => Anthropic;
  stream?: typeof streamAnthropic;
}): StreamFn;
//#endregion
export { createMantleAnthropicStreamFn, resolveMantleAnthropicBaseUrl };