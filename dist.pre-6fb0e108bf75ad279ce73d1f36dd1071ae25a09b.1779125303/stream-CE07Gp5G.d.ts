import { Hn as ProviderWrapStreamFnContext } from "./types-CPAF_tyr.js";
//#region extensions/deepseek/stream.d.ts
declare function createDeepSeekV4ThinkingWrapper(baseStreamFn: ProviderWrapStreamFnContext["streamFn"], thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"]): ProviderWrapStreamFnContext["streamFn"];
//#endregion
export { createDeepSeekV4ThinkingWrapper as t };