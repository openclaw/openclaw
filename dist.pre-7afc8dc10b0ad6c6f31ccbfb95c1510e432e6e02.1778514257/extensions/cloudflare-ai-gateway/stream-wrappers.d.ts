import { kn as ProviderWrapStreamFnContext } from "../../types-BOTb5nyG.js";
import { t as SubsystemLogger } from "../../subsystem-ET63bTu_.js";
import { StreamFn } from "@mariozechner/pi-agent-core";

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