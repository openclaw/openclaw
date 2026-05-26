import { Ln as ProviderWrapStreamFnContext } from "../../types-lCXG2pW_.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/xai/stream.d.ts
declare function createXaiToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function createXaiFastModeWrapper(baseStreamFn: StreamFn | undefined, fastMode: boolean): StreamFn;
declare function wrapXaiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { createXaiFastModeWrapper, createXaiToolPayloadCompatibilityWrapper, wrapXaiProviderStream };