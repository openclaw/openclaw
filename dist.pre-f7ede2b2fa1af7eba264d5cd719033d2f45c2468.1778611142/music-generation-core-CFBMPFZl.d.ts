import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { p as MusicGenerationProviderPlugin } from "./types-DKA4S1yN.js";
//#region src/music-generation/model-ref.d.ts
declare function parseMusicGenerationModelRef(raw: string | undefined): {
  provider: string;
  model: string;
} | null;
//#endregion
//#region src/music-generation/provider-registry.d.ts
declare function listMusicGenerationProviders(cfg?: OpenClawConfig): MusicGenerationProviderPlugin[];
declare function getMusicGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): MusicGenerationProviderPlugin | undefined;
//#endregion
export { listMusicGenerationProviders as n, parseMusicGenerationModelRef as r, getMusicGenerationProvider as t };