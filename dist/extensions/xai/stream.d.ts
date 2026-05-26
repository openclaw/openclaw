import { Hn as ProviderWrapStreamFnContext } from "../../types-Vx7Jq4_-2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/xai/stream.d.ts
declare function createXaiToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
declare function createXaiFastModeWrapper(baseStreamFn: StreamFn | undefined, fastMode: boolean): StreamFn;
declare function wrapXaiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined;
//#endregion
export { createXaiFastModeWrapper, createXaiToolPayloadCompatibilityWrapper, wrapXaiProviderStream };