import {
	normalizeApplyTextNormalization,
	normalizeLanguageCode,
	normalizeSeed,
	requireInRange,
} from "openclaw/plugin-sdk/speech";

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

function isValidVoiceId(voiceId: string): boolean {
	return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

function normalizeElevenLabsBaseUrl(baseUrl?: string): string {
	const trimmed = baseUrl?.trim();
	if (!trimmed) {
		return DEFAULT_ELEVENLABS_BASE_URL;
	}
	return trimmed.replace(/\/+$/, "");
}

function assertElevenLabsVoiceSettings(settings: {
	stability: number;
	similarityBoost: number;
	style: number;
	useSpeakerBoost: boolean;
	speed: number;
}) {
	requireInRange(settings.stability, 0, 1, "stability");
	requireInRange(settings.similarityBoost, 0, 1, "similarityBoost");
	requireInRange(settings.style, 0, 1, "style");
	requireInRange(settings.speed, 0.5, 2, "speed");
}

export async function elevenLabsTTS(params: {
	text: string;
	apiKey: string;
	baseUrl: string;
	voiceId: string;
	modelId: string;
	outputFormat: string;
	seed?: number;
	applyTextNormalization?: "auto" | "on" | "off";
	languageCode?: string;
	voiceSettings: {
		stability: number;
		similarityBoost: number;
		style: number;
		useSpeakerBoost: boolean;
		speed: number;
	};
	timeoutMs: number;
}): Promise<Buffer> {
	const {
		text,
		apiKey,
		baseUrl,
		voiceId,
		modelId,
		outputFormat,
		seed,
		applyTextNormalization,
		languageCode,
		voiceSettings,
		timeoutMs,
	} = params;
	if (!isValidVoiceId(voiceId)) {
		throw new Error("Invalid voiceId format");
	}
	assertElevenLabsVoiceSettings(voiceSettings);
	const normalizedLanguage = normalizeLanguageCode(languageCode);
	const normalizedNormalization = normalizeApplyTextNormalization(
		applyTextNormalization,
	);
	const normalizedSeed = normalizeSeed(seed);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const url = new URL(
			`${normalizeElevenLabsBaseUrl(baseUrl)}/v1/text-to-speech/${voiceId}`,
		);
		if (outputFormat) {
			url.searchParams.set("output_format", outputFormat);
		}

		const response = await fetch(url.toString(), {
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({
				text,
				model_id: modelId,
				seed: normalizedSeed,
				apply_text_normalization: normalizedNormalization,
				language_code: normalizedLanguage,
				voice_settings: {
					stability: voiceSettings.stability,
					similarity_boost: voiceSettings.similarityBoost,
					style: voiceSettings.style,
					use_speaker_boost: voiceSettings.useSpeakerBoost,
					speed: voiceSettings.speed,
				},
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`ElevenLabs API error (${response.status})`);
		}

		return Buffer.from(await response.arrayBuffer());
	} finally {
		clearTimeout(timeout);
	}
}
