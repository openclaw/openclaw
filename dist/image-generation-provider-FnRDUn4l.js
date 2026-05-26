import { t as canonicalizeBase64 } from "./base64-D03BM6T6.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest, p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import "./media-runtime-BheBFFxc.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/minimax/image-generation-provider.ts
const DEFAULT_MINIMAX_IMAGE_BASE_URL = "https://api.minimax.io";
const CN_MINIMAX_IMAGE_BASE_URL = "https://api.minimaxi.com";
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
	"21:9"
];
function isMinimaxCnHost(value) {
	const trimmed = value?.trim();
	if (!trimmed) return false;
	const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const hostname = new URL(candidate).hostname.toLowerCase();
		return hostname === "minimaxi.com" || hostname.endsWith(".minimaxi.com");
	} catch {
		return false;
	}
}
function resolveMinimaxImageBaseUrl(cfg, providerId) {
	const apiHost = process.env.MINIMAX_API_HOST;
	if (isMinimaxCnHost(apiHost)) return CN_MINIMAX_IMAGE_BASE_URL;
	const providerBaseUrl = cfg?.models?.providers?.[providerId]?.baseUrl;
	if (isMinimaxCnHost(providerBaseUrl)) return CN_MINIMAX_IMAGE_BASE_URL;
	return DEFAULT_MINIMAX_IMAGE_BASE_URL;
}
function buildMinimaxImageProvider(providerId) {
	return {
		id: providerId,
		label: "MiniMax",
		defaultModel: DEFAULT_MODEL,
		models: [DEFAULT_MODEL],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: providerId,
			agentDir
		}),
		capabilities: {
			generate: {
				maxCount: 9,
				supportsSize: false,
				supportsAspectRatio: true,
				supportsResolution: false
			},
			edit: {
				enabled: true,
				maxCount: 9,
				maxInputImages: 1,
				supportsSize: false,
				supportsAspectRatio: true,
				supportsResolution: false
			},
			geometry: { aspectRatios: [...MINIMAX_SUPPORTED_ASPECT_RATIOS] }
		},
		async generateImage(req) {
			const auth = await resolveApiKeyForProvider({
				provider: providerId,
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("MiniMax API key missing");
			const { baseUrl: resolvedBaseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
				baseUrl: resolveMinimaxImageBaseUrl(req.cfg, providerId),
				defaultBaseUrl: DEFAULT_MINIMAX_IMAGE_BASE_URL,
				allowPrivateNetwork: false,
				defaultHeaders: {
					Authorization: `Bearer ${auth.apiKey}`,
					"Content-Type": "application/json"
				},
				provider: providerId,
				capability: "image",
				transport: "http"
			});
			const body = {
				model: req.model || DEFAULT_MODEL,
				prompt: req.prompt,
				response_format: "base64",
				n: req.count ?? 1
			};
			if (req.aspectRatio?.trim()) body.aspect_ratio = req.aspectRatio.trim();
			if (req.inputImages && req.inputImages.length > 0) {
				const ref = req.inputImages[0];
				body.subject_reference = [{
					type: "character",
					image_file: `data:${ref.mimeType || "image/jpeg"};base64,${ref.buffer.toString("base64")}`
				}];
			}
			const { response, release } = await postJsonRequest({
				url: `${resolvedBaseUrl}/v1/image_generation`,
				headers,
				body,
				timeoutMs: req.timeoutMs,
				fetchFn: fetch,
				allowPrivateNetwork,
				ssrfPolicy: req.ssrfPolicy,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(response, "MiniMax image generation failed");
				const data = await response.json();
				const baseResp = data.base_resp;
				if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
					const msg = baseResp.status_msg ?? "";
					throw new Error(`MiniMax image generation API error (${baseResp.status_code}): ${msg}`);
				}
				const base64Images = data.data?.image_base64 ?? [];
				const failedCount = data.metadata?.failed_count ?? 0;
				if (base64Images.length === 0) {
					const reason = failedCount > 0 ? `${failedCount} image(s) failed to generate` : "no images returned";
					throw new Error(`MiniMax image generation returned no images: ${reason}`);
				}
				return {
					images: base64Images.map((b64, index) => {
						if (!b64) return null;
						const canonicalBase64 = canonicalizeBase64(b64);
						if (!canonicalBase64) throw new Error("MiniMax image generation returned malformed image base64");
						return {
							buffer: Buffer.from(canonicalBase64, "base64"),
							mimeType: DEFAULT_OUTPUT_MIME,
							fileName: `image-${index + 1}.png`
						};
					}).filter((entry) => entry !== null),
					model: req.model || DEFAULT_MODEL
				};
			} finally {
				await release();
			}
		}
	};
}
function buildMinimaxImageGenerationProvider() {
	return buildMinimaxImageProvider("minimax");
}
function buildMinimaxPortalImageGenerationProvider() {
	return buildMinimaxImageProvider("minimax-portal");
}
//#endregion
export { buildMinimaxPortalImageGenerationProvider as n, buildMinimaxImageGenerationProvider as t };
