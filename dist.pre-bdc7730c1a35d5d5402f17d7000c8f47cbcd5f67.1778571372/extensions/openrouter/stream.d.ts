import { Ln as ProviderWrapStreamFnContext } from "../../types-D1CySu2x.js";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/openrouter/stream.d.ts
declare function wrapOpenRouterProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | null | undefined;
//#endregion
export { wrapOpenRouterProviderStream };