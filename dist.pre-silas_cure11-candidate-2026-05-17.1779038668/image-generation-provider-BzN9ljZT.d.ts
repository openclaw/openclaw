import { l as ImageGenerationProvider } from "./types-DVoANSAT.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-CwCJqokG.js";
//#region extensions/fal/image-generation-provider.d.ts
declare function _setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { buildFalImageGenerationProvider as n, _setFalFetchGuardForTesting as t };