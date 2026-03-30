import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";

const DEFAULT_MINIMAX_IMAGE_BASE_URL = "https://api.minimax.io";
const DEFAULT_MODEL = "image-01";
const DEFAULT_OUTPUT_MIME = "image/png";
const MINIMAX_SUPPORTED_ASPECT_RATIOS = [
	"1:1",
	"16:9",
	"4:3",
	"3:2",
	"2:3",
	"3:4",
	"9:16",
	"21:9",
] as const;

type MinimaxImageApiResponse = {
	data?: {
		image_base64?: string[];
	};
	metadata?: {
		success_count?: number;
		failed_count?: number;
	};
	id?: string;
	base_resp?: {
		status_code?: number;
		status_msg?: string;
	};
};

function resolveMinimaxImageBaseUrl(
	cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
	providerId: string,
): string {
	const direct = cfg?.models?.providers?.[providerId]?.baseUrl?.trim();
	if (!direct) {
		return DEFAULT_MINIMAX_IMAGE_BASE_URL;
	}
	// Extract origin from the configured base URL (which may include path like /anthropic)
	try {
		return new URL(direct).origin;
	} catch {
		return DEFAULT_MINIMAX_IMAGE_BASE_URL;
	}
}

function buildMinimaxImageProvider(
	providerId: string,
): ImageGenerationProvider {
	return {
		id: providerId,
		label: "MiniMax",
		defaultModel: DEFAULT_MODEL,
		models: [DEFAULT_MODEL],
		capabilities: {
			generate: {
				maxCount: 9,
				supportsSize: false,
				supportsAspectRatio: true,
				supportsResolution: false,
			},
			edit: {
				enabled: true,
				maxCount: 9,
				maxInputImages: 1,
				supportsSize: false,
				supportsAspectRatio: true,
				supportsResolution: false,
			},
			geometry: {
				aspectRatios: [...MINIMAX_SUPPORTED_ASPECT_RATIOS],
			},
		},
		async generateImage(req) {
			const auth = await resolveApiKeyForProvider({
				provider: providerId,
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore,
			});
			if (!auth.apiKey) {
				throw new Error("MiniMax API key missing");
			}

			const baseUrl = resolveMinimaxImageBaseUrl(req.cfg, providerId);

			const body: Record<string, unknown> = {
				model: req.model || DEFAULT_MODEL,
				prompt: req.prompt,
				response_format: "base64",
				n: req.count ?? 1,
			};

			if (req.aspectRatio?.trim()) {
				body.aspect_ratio = req.aspectRatio.trim();
			}

			// Map input images to subject_reference for image-to-image generation
			if (req.inputImages && req.inputImages.length > 0) {
				const ref = req.inputImages[0];
				const mime = ref.mimeType || "image/jpeg";
				const dataUrl = `data:${mime};base64,${ref.buffer.toString("base64")}`;
				body.subject_reference = [{ type: "character", image_file: dataUrl }];
			}

			const controller = new AbortController();
			const timeoutMs = req.timeoutMs;
			const timeout =
				typeof timeoutMs === "number" &&
				Number.isFinite(timeoutMs) &&
				timeoutMs > 0
					? setTimeout(() => controller.abort(), timeoutMs)
					: undefined;

			const response = await fetch(`${baseUrl}/v1/image_generation`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${auth.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			}).finally(() => {
				clearTimeout(timeout);
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(
					`MiniMax image generation failed (${response.status}): ${text || response.statusText}`,
				);
			}

			const data = (await response.json()) as MinimaxImageApiResponse;

			const baseResp = data.base_resp;
			if (
				baseResp &&
				typeof baseResp.status_code === "number" &&
				baseResp.status_code !== 0
			) {
				const msg = baseResp.status_msg ?? "";
				throw new Error(
					`MiniMax image generation API error (${baseResp.status_code}): ${msg}`,
				);
			}

			const base64Images = data.data?.image_base64 ?? [];
			const failedCount = data.metadata?.failed_count ?? 0;

			if (base64Images.length === 0) {
				const reason =
					failedCount > 0
						? `${failedCount} image(s) failed to generate`
						: "no images returned";
				throw new Error(
					`MiniMax image generation returned no images: ${reason}`,
				);
			}

			const images = base64Images
				.map((b64, index) => {
					if (!b64) {
						return null;
					}
					return {
						buffer: Buffer.from(b64, "base64"),
						mimeType: DEFAULT_OUTPUT_MIME,
						fileName: `image-${index + 1}.png`,
					};
				})
				.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

			return {
				images,
				model: req.model || DEFAULT_MODEL,
			};
		},
	};
}

export function buildMinimaxImageGenerationProvider(): ImageGenerationProvider {
	return buildMinimaxImageProvider("minimax");
}

export function buildMinimaxPortalImageGenerationProvider(): ImageGenerationProvider {
	return buildMinimaxImageProvider("minimax-portal");
}
