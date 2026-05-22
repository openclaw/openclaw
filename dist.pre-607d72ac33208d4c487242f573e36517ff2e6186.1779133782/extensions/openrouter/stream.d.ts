import { Hn as ProviderWrapStreamFnContext } from "../../types-XJr-3iEG.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/openrouter/stream.d.ts
declare function wrapOpenRouterProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | null | undefined;
//#endregion
export { wrapOpenRouterProviderStream };