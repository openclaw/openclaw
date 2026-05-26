import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
//#region extensions/google/generation-provider-metadata.ts
const DEFAULT_GOOGLE_MUSIC_MODEL = "lyria-3-clip-preview";
const GOOGLE_PRO_MUSIC_MODEL = "lyria-3-pro-preview";
const GOOGLE_MAX_INPUT_IMAGES = 10;
const DEFAULT_GOOGLE_VIDEO_MODEL = "veo-3.1-fast-generate-preview";
const GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS = [
	4,
	6,
	8
];
const GOOGLE_VIDEO_MIN_DURATION_SECONDS = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[0];
const GOOGLE_VIDEO_MAX_DURATION_SECONDS = GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS[GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.length - 1];
function isGoogleProviderConfigured(ctx) {
	return isProviderApiKeyConfigured({
		provider: "google",
		agentDir: ctx.agentDir
	});
}
function createGoogleMusicGenerationProviderMetadata() {
	return {
		id: "google",
		label: "Google",
		defaultModel: DEFAULT_GOOGLE_MUSIC_MODEL,
		models: [DEFAULT_GOOGLE_MUSIC_MODEL, GOOGLE_PRO_MUSIC_MODEL],
		isConfigured: isGoogleProviderConfigured,
		capabilities: {
			generate: {
				maxTracks: 1,
				supportsLyrics: true,
				supportsInstrumental: true,
				supportsFormat: true,
				supportedFormatsByModel: {
					[DEFAULT_GOOGLE_MUSIC_MODEL]: ["mp3"],
					[GOOGLE_PRO_MUSIC_MODEL]: ["mp3", "wav"]
				}
			},
			edit: {
				enabled: true,
				maxTracks: 1,
				maxInputImages: 10,
				supportsLyrics: true,
				supportsInstrumental: true,
				supportsFormat: true,
				supportedFormatsByModel: {
					[DEFAULT_GOOGLE_MUSIC_MODEL]: ["mp3"],
					[GOOGLE_PRO_MUSIC_MODEL]: ["mp3", "wav"]
				}
			}
		}
	};
}
function createGoogleVideoGenerationProviderMetadata() {
	return {
		id: "google",
		label: "Google",
		defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
		models: [
			DEFAULT_GOOGLE_VIDEO_MODEL,
			"veo-3.1-generate-preview",
			"veo-3.1-lite-generate-preview",
			"veo-3.0-fast-generate-001",
			"veo-3.0-generate-001",
			"veo-2.0-generate-001"
		],
		isConfigured: isGoogleProviderConfigured,
		capabilities: {
			generate: {
				maxVideos: 1,
				maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
				supportedDurationSeconds: [...GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS],
				aspectRatios: ["16:9", "9:16"],
				resolutions: ["720P", "1080P"],
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: true,
				supportsAudio: false
			},
			imageToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputImages: 1,
				maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
				supportedDurationSeconds: [...GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS],
				aspectRatios: ["16:9", "9:16"],
				resolutions: ["720P", "1080P"],
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: true,
				supportsAudio: false
			},
			videoToVideo: {
				enabled: true,
				maxVideos: 1,
				maxInputVideos: 1,
				maxDurationSeconds: GOOGLE_VIDEO_MAX_DURATION_SECONDS,
				supportedDurationSeconds: [...GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS],
				aspectRatios: ["16:9", "9:16"],
				resolutions: ["720P", "1080P"],
				supportsAspectRatio: true,
				supportsResolution: true,
				supportsSize: true,
				supportsAudio: false
			}
		}
	};
}
//#endregion
export { GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS as a, createGoogleMusicGenerationProviderMetadata as c, GOOGLE_PRO_MUSIC_MODEL as i, createGoogleVideoGenerationProviderMetadata as l, DEFAULT_GOOGLE_VIDEO_MODEL as n, GOOGLE_VIDEO_MAX_DURATION_SECONDS as o, GOOGLE_MAX_INPUT_IMAGES as r, GOOGLE_VIDEO_MIN_DURATION_SECONDS as s, DEFAULT_GOOGLE_MUSIC_MODEL as t };
