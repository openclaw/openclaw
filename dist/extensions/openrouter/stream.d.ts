import { Ln as ProviderWrapStreamFnContext } from "../../types-lCXG2pW_.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/openrouter/stream.d.ts
declare function wrapOpenRouterProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | null | undefined;
//#endregion
export { wrapOpenRouterProviderStream };