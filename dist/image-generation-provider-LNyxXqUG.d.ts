import { l as ImageGenerationProvider } from "./types-C-TYaOW6.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-Bx-8dg5s.js";
//#region extensions/fal/image-generation-provider.d.ts
declare function _setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { buildFalImageGenerationProvider as n, _setFalFetchGuardForTesting as t };