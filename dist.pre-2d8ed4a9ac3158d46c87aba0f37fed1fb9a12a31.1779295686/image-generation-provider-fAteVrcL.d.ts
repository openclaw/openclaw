import { l as ImageGenerationProvider } from "./types-DJRt10UN.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-DlNZ6eLr.js";
//#region extensions/fal/image-generation-provider.d.ts
declare function setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { setFalFetchGuardForTesting as n, buildFalImageGenerationProvider as t };