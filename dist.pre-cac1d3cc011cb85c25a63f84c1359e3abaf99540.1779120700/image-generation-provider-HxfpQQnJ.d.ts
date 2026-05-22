import { l as ImageGenerationProvider } from "./types-Cyjs8MS3.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-DG95ojWq.js";
//#region extensions/fal/image-generation-provider.d.ts
declare function _setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { buildFalImageGenerationProvider as n, _setFalFetchGuardForTesting as t };