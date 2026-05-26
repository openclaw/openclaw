import type { MusicGenerationEditCapabilities, MusicGenerationMode, MusicGenerationModeCapabilities, MusicGenerationProvider } from "./types.js";
export declare function resolveMusicGenerationMode(params: {
    inputImageCount?: number;
}): MusicGenerationMode;
export declare function listSupportedMusicGenerationModes(provider: Pick<MusicGenerationProvider, "capabilities">): MusicGenerationMode[];
export declare function resolveMusicGenerationModeCapabilities(params: {
    provider?: Pick<MusicGenerationProvider, "capabilities">;
    inputImageCount?: number;
}): {
    mode: MusicGenerationMode;
    capabilities: MusicGenerationModeCapabilities | MusicGenerationEditCapabilities | undefined;
};
