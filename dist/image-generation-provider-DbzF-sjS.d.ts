import { l as ImageGenerationProvider } from "./types-BaGDaXQN.js";
import { a as fetchWithSsrFGuard } from "./fetch-guard-BgaCy73h.js";
//#region extensions/fal/image-generation-provider.d.ts
declare function setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void;
declare function buildFalImageGenerationProvider(): ImageGenerationProvider;
//#endregion
export { setFalFetchGuardForTesting as n, buildFalImageGenerationProvider as t };