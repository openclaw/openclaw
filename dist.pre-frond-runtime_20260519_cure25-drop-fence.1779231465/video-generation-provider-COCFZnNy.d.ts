import { a as fetchWithSsrFGuard } from "./fetch-guard-BzbwrEoM.js";
import { o as VideoGenerationProvider } from "./video-generation-DiDt1X4A.js";
//#region extensions/fal/video-generation-provider.d.ts
declare function setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalVideoGenerationProvider(): VideoGenerationProvider;
//#endregion
export { setFalVideoFetchGuardForTesting as n, buildFalVideoGenerationProvider as t };