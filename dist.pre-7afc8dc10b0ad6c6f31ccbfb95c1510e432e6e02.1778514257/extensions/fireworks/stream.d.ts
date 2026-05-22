import { kn as ProviderWrapStreamFnContext } from "../../types-BOTb5nyG.js";
import { StreamFn } from "@mariozechner/pi-agent-core";

//#region extensions/fireworks/stream.d.ts
declare function createFireworksKimiThinkingDisabledWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function wrapFireworksProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { createFireworksKimiThinkingDisabledWrapper, wrapFireworksProviderStream };