import { a as fetchWithSsrFGuard } from "./fetch-guard-CwCJqokG.js";
import { o as VideoGenerationProvider } from "./video-generation-WJRK2RgO.js";
//#region extensions/fal/video-generation-provider.d.ts
declare function _setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalVideoGenerationProvider(): VideoGenerationProvider;
//#endregion
export { buildFalVideoGenerationProvider as n, _setFalVideoFetchGuardForTesting as t };