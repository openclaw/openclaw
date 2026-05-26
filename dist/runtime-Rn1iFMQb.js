import "./fs-safe-DpJlqO1z.js";
import { i as readLocalFileSafely } from "./secure-temp-dir-GC3bO7Qi.js";
import { n as normalizeMediaProviderId } from "./config-provider-models-DxFLCJCh.js";
import { t as describeImageWithModel } from "./image-runtime-pndfllVY.js";
import { d as getMediaUnderstandingProvider, u as buildMediaUnderstandingRegistry } from "./defaults.constants-CRZ3dal0.js";
import { a as runCapability, o as createMediaAttachmentCache, s as normalizeMediaAttachments, t as buildProviderRegistry } from "./runner-DjFT6is3.js";
import { i as normalizeDecisionReason, n as findDecisionReason } from "./runner.entries-BW-r9RsX.js";
import path from "node:path";
//#region src/media-understanding/runtime.ts
const KIND_BY_CAPABILITY = {
	audio: "audio.transcription",
	image: "image.description",
	video: "video.description"
};
function resolveDecisionFailureReason(decision) {
	return normalizeDecisionReason(findDecisionReason(decision, "failed"));
}
function buildFileContext(params) {
	return {
		MediaPath: params.filePath,
		MediaType: params.mime
	};
}
function hasStructuredImageInput(input) {
	return input.some((entry) => entry.type === "image");
}
async function runMediaUnderstandingFile(params) {
	const requestPrompt = params.prompt?.trim();
	const requestTimeoutSeconds = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.ceil(params.timeoutMs / 1e3) : void 0;
	const cfg = requestPrompt || requestTimeoutSeconds !== void 0 ? {
		...params.cfg,
		tools: {
			...params.cfg.tools,
			media: {
				...params.cfg.tools?.media,
				[params.capability]: {
					...params.cfg.tools?.media?.[params.capability],
					...requestPrompt ? {
						prompt: requestPrompt,
						_requestPromptOverride: requestPrompt
					} : {},
					...requestTimeoutSeconds !== void 0 ? { timeoutSeconds: requestTimeoutSeconds } : {}
				}
			}
		}
	} : params.cfg;
	const ctx = buildFileContext(params);
	const attachments = normalizeMediaAttachments(ctx);
	if (attachments.length === 0) return {
		text: void 0,
		decision: {
			capability: params.capability,
			outcome: "no-attachment",
			attachments: []
		}
	};
	const config = cfg.tools?.media?.[params.capability];
	if (config?.enabled === false) return {
		text: void 0,
		provider: void 0,
		model: void 0,
		output: void 0,
		decision: {
			capability: params.capability,
			outcome: "disabled",
			attachments: []
		}
	};
	const providerRegistry = buildProviderRegistry(void 0, cfg);
	const cache = createMediaAttachmentCache(attachments, {
		localPathRoots: [path.dirname(params.filePath)],
		ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy
	});
	try {
		const result = await runCapability({
			capability: params.capability,
			cfg,
			ctx,
			attachments: cache,
			media: attachments,
			agentDir: params.agentDir,
			providerRegistry,
			config,
			activeModel: params.activeModel
		});
		if (result.outputs.length === 0 && result.decision.outcome === "failed") throw new Error(resolveDecisionFailureReason(result.decision) ?? `${params.capability} understanding failed`);
		const output = result.outputs.find((entry) => entry.kind === KIND_BY_CAPABILITY[params.capability]);
		const fileResult = {
			text: output?.text?.trim() || void 0,
			provider: output?.provider,
			model: output?.model,
			output
		};
		if (result.decision) fileResult.decision = result.decision;
		return fileResult;
	} finally {
		await cache.cleanup();
	}
}
async function describeImageFile(params) {
	return await runMediaUnderstandingFile({
		...params,
		capability: "image"
	});
}
async function describeImageFileWithModel(params) {
	const timeoutMs = params.timeoutMs ?? 3e4;
	const provider = buildProviderRegistry(void 0, params.cfg).get(normalizeMediaProviderId(params.provider));
	const buffer = (await readLocalFileSafely({ filePath: params.filePath })).buffer;
	return await (provider?.describeImage ?? describeImageWithModel)({
		buffer,
		fileName: path.basename(params.filePath),
		mime: params.mime,
		provider: params.provider,
		model: params.model,
		prompt: params.prompt,
		maxTokens: params.maxTokens,
		timeoutMs,
		cfg: params.cfg,
		agentDir: params.agentDir ?? ""
	});
}
async function extractStructuredWithModel(params) {
	const timeoutMs = params.timeoutMs ?? 3e4;
	if (!hasStructuredImageInput(params.input)) throw new Error("Structured extraction requires at least one image input.");
	const provider = getMediaUnderstandingProvider(params.provider, buildMediaUnderstandingRegistry(void 0, params.cfg));
	if (!provider?.extractStructured) throw new Error(`Provider does not support structured extraction: ${params.provider}`);
	return await provider.extractStructured({
		input: params.input,
		instructions: params.instructions,
		schemaName: params.schemaName,
		jsonSchema: params.jsonSchema,
		jsonMode: params.jsonMode,
		provider: params.provider,
		model: params.model,
		profile: params.profile,
		preferredProfile: params.preferredProfile,
		authStore: params.authStore,
		timeoutMs,
		cfg: params.cfg,
		agentDir: params.agentDir ?? ""
	});
}
async function describeVideoFile(params) {
	return await runMediaUnderstandingFile({
		...params,
		capability: "video"
	});
}
async function transcribeAudioFile(params) {
	const cfg = params.language || params.prompt ? {
		...params.cfg,
		tools: {
			...params.cfg.tools,
			media: {
				...params.cfg.tools?.media,
				audio: {
					...params.cfg.tools?.media?.audio,
					...params.language ? { _requestLanguageOverride: params.language } : {},
					...params.prompt ? { _requestPromptOverride: params.prompt } : {},
					...params.language ? { language: params.language } : {},
					...params.prompt ? { prompt: params.prompt } : {}
				}
			}
		}
	} : params.cfg;
	return await runMediaUnderstandingFile({
		...params,
		cfg,
		capability: "audio"
	});
}
//#endregion
export { runMediaUnderstandingFile as a, extractStructuredWithModel as i, describeImageFileWithModel as n, transcribeAudioFile as o, describeVideoFile as r, describeImageFile as t };
