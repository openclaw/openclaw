import "./fs-safe-CV86zY9G.js";
import { i as readLocalFileSafely } from "./secure-temp-dir-aidxCRgA.js";
import { c as kindFromMime, l as mimeTypeFromFilePath } from "./mime-DppuT-pZ.js";
import { n as normalizeMediaProviderId } from "./provider-id-BETgOIvU.js";
import { t as describeImageWithModel } from "./image-runtime-Dye6Uj6e.js";
import { d as getMediaUnderstandingProvider, n as DEFAULT_MAX_BYTES, u as buildMediaUnderstandingRegistry } from "./defaults.constants-DeIx7Gbv.js";
import { a as runCapability, o as createMediaAttachmentCache, s as normalizeMediaAttachments, t as buildProviderRegistry } from "./runner-C8f8m91V.js";
import { i as normalizeDecisionReason, n as findDecisionReason } from "./runner.entries-CxY7Q-di.js";
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
	const remoteRef = params.mediaUrl ?? (isRemoteMediaReference(params.filePath) ? params.filePath.trim() : void 0);
	const extensionMime = remoteRef ? mimeTypeFromFilePath(remoteRef) : void 0;
	const extensionKind = kindFromMime(extensionMime);
	const mediaType = params.mime ?? (remoteRef && params.capability && extensionKind === params.capability ? `${params.capability}/*` : extensionMime) ?? (remoteRef && params.capability ? `${params.capability}/*` : void 0);
	if (remoteRef) return {
		MediaUrl: remoteRef,
		MediaType: mediaType
	};
	return {
		MediaPath: params.filePath,
		MediaType: mediaType
	};
}
function isRemoteMediaReference(value) {
	return /^https?:\/\//i.test(value.trim());
}
function concreteMime(mime) {
	const normalized = mime?.trim();
	if (!normalized || normalized.endsWith("/*")) return;
	return normalized;
}
function resolveFileLocalRoots(filePath) {
	return isRemoteMediaReference(filePath) ? void 0 : [path.dirname(filePath)];
}
function basenameFromMediaReference(value) {
	if (isRemoteMediaReference(value)) try {
		const url = new URL(value);
		return path.basename(url.pathname) || "image";
	} catch {}
	return path.basename(value);
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
	const ctx = buildFileContext({
		...params,
		capability: params.capability
	});
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
		localPathRoots: params.mediaUrl ? void 0 : resolveFileLocalRoots(params.filePath),
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
			...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {},
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
	const image = await readImageDescriptionInput({
		filePath: params.filePath,
		mediaUrl: params.mediaUrl,
		mime: params.mime,
		cfg: params.cfg,
		timeoutMs
	});
	return await (provider?.describeImage ?? describeImageWithModel)({
		buffer: image.buffer,
		fileName: image.fileName,
		mime: image.mime,
		provider: params.provider,
		model: params.model,
		prompt: params.prompt,
		maxTokens: params.maxTokens,
		timeoutMs,
		cfg: params.cfg,
		agentDir: params.agentDir ?? "",
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
}
async function readImageDescriptionInput(params) {
	const remoteRef = params.mediaUrl ?? (isRemoteMediaReference(params.filePath) ? params.filePath.trim() : void 0);
	if (!remoteRef) return {
		buffer: (await readLocalFileSafely({ filePath: params.filePath })).buffer,
		fileName: basenameFromMediaReference(params.filePath),
		mime: params.mime
	};
	const cache = createMediaAttachmentCache(normalizeMediaAttachments(buildFileContext({
		...params,
		capability: "image"
	})), { ssrfPolicy: params.cfg.tools?.web?.fetch?.ssrfPolicy });
	try {
		const media = await cache.getBuffer({
			attachmentIndex: 0,
			maxBytes: DEFAULT_MAX_BYTES.image,
			timeoutMs: params.timeoutMs
		});
		return {
			buffer: media.buffer,
			fileName: media.fileName || basenameFromMediaReference(remoteRef),
			mime: concreteMime(params.mime) ?? media.mime
		};
	} finally {
		await cache.cleanup();
	}
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
