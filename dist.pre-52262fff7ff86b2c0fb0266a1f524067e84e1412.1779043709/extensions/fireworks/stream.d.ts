import { Rn as ProviderWrapStreamFnContext } from "../../types-BM0xoSYJ2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/fireworks/stream.d.ts
declare function createFireworksKimiThinkingDisabledWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function wrapFireworksProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { createFireworksKimiThinkingDisabledWrapper, wrapFireworksProviderStream };