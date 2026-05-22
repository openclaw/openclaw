import type { StreamFn } from "@mariozechner/pi-agent-core";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";
export declare function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export { isAnthropicBedrockModel };
