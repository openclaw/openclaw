import { Hn as ProviderWrapStreamFnContext } from "../../types-Vx7Jq4_-2.js";
import { t as SubsystemLogger } from "../../subsystem-Ce5qcC5n.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/cloudflare-ai-gateway/stream-wrappers.d.ts
declare function shouldPatchAnthropicMessagesPayload(model: ProviderWrapStreamFnContext["model"]): boolean;
declare function createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function wrapCloudflareAiGatewayProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
declare const testing: {
  log: SubsystemLogger;
  shouldPatchAnthropicMessagesPayload: typeof shouldPatchAnthropicMessagesPayload;
};
//#endregion
export { testing as __testing, testing, createCloudflareAiGatewayAnthropicThinkingPrefillWrapper, wrapCloudflareAiGatewayProviderStream };