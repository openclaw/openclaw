import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest } from "./shared-D8kCtbT2.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import "./provider-http-CYBE-CBM.js";
import { d as resolveVydraResponseJobId, f as resolveVydraResponseStatus, l as resolveCompletedVydraPayload, n as DEFAULT_VYDRA_IMAGE_MODEL, o as downloadVydraAsset, s as extractVydraResultUrls, u as resolveVydraRequestContext } from "./shared-2GSunP-l.js";
//#region extensions/vydra/image-generation-provider.ts
function buildVydraImageGenerationProvider() {
	return {
		id: "vydra",
		label: "Vydra",
		defaultModel: DEFAULT_VYDRA_IMAGE_MODEL,
		models: [DEFAULT_VYDRA_IMAGE_MODEL],
		isConfigured: ({ agentDir }) => isProviderApiKeyConfigured({
			provider: "vydra",
			agentDir
		}),
		capabilities: {
			generate: {
				maxCount: 1,
				supportsSize: false,
				supportsAspectRatio: false,
				supportsResolution: false
			},
			edit: {
				enabled: false,
				maxCount: 1,
				maxInputImages: 0,
				supportsSize: false,
				supportsAspectRatio: false,
				supportsResolution: false
			}
		},
		async generateImage(req) {
			if ((req.inputImages?.length ?? 0) > 0) throw new Error("Vydra image generation currently supports text-to-image only in the bundled plugin.");
			if ((req.count ?? 1) > 1) throw new Error("Vydra image generation supports at most one image per request.");
			const { fetchFn, baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = await resolveVydraRequestContext({
				cfg: req.cfg,
				agentDir: req.agentDir,
				authStore: req.authStore,
				capability: "image"
			});
			const model = req.model?.trim() || "grok-imagine";
			const { response, release } = await postJsonRequest({
				url: `${baseUrl}/models/${model}`,
				headers,
				body: {
					prompt: req.prompt,
					model: "text-to-image"
				},
				timeoutMs: req.timeoutMs,
				fetchFn,
				allowPrivateNetwork,
				ssrfPolicy: req.ssrfPolicy,
				dispatcherPolicy
			});
			try {
				await assertOkOrThrowHttpError(response, "Vydra image generation failed");
				const submitted = await response.json();
				const completedPayload = await resolveCompletedVydraPayload({
					submitted,
					baseUrl,
					headers,
					timeoutMs: req.timeoutMs,
					fetchFn,
					kind: "image",
					missingJobIdMessage: "Vydra image generation response missing job id"
				});
				const imageUrl = extractVydraResultUrls(completedPayload, "image")[0];
				if (!imageUrl) throw new Error("Vydra image generation completed without an image URL");
				const image = await downloadVydraAsset({
					url: imageUrl,
					kind: "image",
					timeoutMs: req.timeoutMs,
					fetchFn
				});
				return {
					images: [{
						buffer: image.buffer,
						mimeType: image.mimeType,
						fileName: image.fileName
					}],
					model,
					metadata: {
						jobId: resolveVydraResponseJobId(completedPayload) ?? resolveVydraResponseJobId(submitted),
						imageUrl,
						status: resolveVydraResponseStatus(completedPayload) ?? "completed"
					}
				};
			} finally {
				await release();
			}
		}
	};
}
//#endregion
export { buildVydraImageGenerationProvider as t };
