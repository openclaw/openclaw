import { Hn as ProviderWrapStreamFnContext } from "../../types-Vx7Jq4_-2.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/openrouter/stream.d.ts
declare function wrapOpenRouterProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | null | undefined;
//#endregion
export { wrapOpenRouterProviderStream };