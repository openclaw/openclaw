import { a as fetchWithSsrFGuard } from "./fetch-guard-C1kYqyXr.js";
import { o as VideoGenerationProvider } from "./video-generation-BGCtdW9t.js";
//#region extensions/fal/video-generation-provider.d.ts
declare function setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalVideoGenerationProvider(): VideoGenerationProvider;
//#endregion
export { setFalVideoFetchGuardForTesting as n, buildFalVideoGenerationProvider as t };