import { Ln as ProviderWrapStreamFnContext } from "../../types-CyE3PKKi.js";
import { t as SubsystemLogger } from "../../subsystem-B962FG0G.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/cloudflare-ai-gateway/stream-wrappers.d.ts
declare function shouldPatchAnthropicMessagesPayload(model: ProviderWrapStreamFnContext["model"]): boolean;
declare function createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function wrapCloudflareAiGatewayProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
declare const __testing: {
  log: SubsystemLogger;
  shouldPatchAnthropicMessagesPayload: typeof shouldPatchAnthropicMessagesPayload;
};
//#endregion
export { __testing, createCloudflareAiGatewayAnthropicThinkingPrefillWrapper, wrapCloudflareAiGatewayProviderStream };