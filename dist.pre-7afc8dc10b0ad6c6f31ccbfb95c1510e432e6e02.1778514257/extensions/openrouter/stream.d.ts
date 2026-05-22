import { kn as ProviderWrapStreamFnContext } from "../../types-BOTb5nyG.js";
import { StreamFn } from "@mariozechner/pi-agent-core";

//#region extensions/openrouter/stream.d.ts
declare function wrapOpenRouterProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | null | undefined;
//#endregion
export { wrapOpenRouterProviderStream };