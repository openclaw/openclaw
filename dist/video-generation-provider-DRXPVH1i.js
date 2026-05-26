import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as writeExternalFileWithinRoot } from "./fs-safe-CV86zY9G.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { r as withTempWorkspace } from "./private-temp-workspace-DgditT3G.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./temp-path-DllZid8c.js";
import { t as executeProviderOperationWithRetry } from "./operation-retry-DSyuuv9E.js";
import { h as waitProviderOperationPollInterval, m as resolveProviderOperationTimeoutMs, n as createProviderOperationDeadline } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./security-runtime-CcSekjBd.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { o as resolveGoogleGenerativeAiApiOrigin } from "./provider-policy-C3QGAGLZ.js";
import { a as GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS, l as createGoogleVideoGenerationProviderMetadata, o as GOOGLE_VIDEO_MAX_DURATION_SECONDS, s as GOOGLE_VIDEO_MIN_DURATION_SECONDS } from "./generation-provider-metadata-DOgeZPJU.js";
import { t as parseGeminiAuth } from "./gemini-auth-BjLpmB9U.js";
import "./api-B6GzhKwj.js";
import { t as createGoogleGenAI } from "./google-genai-runtime-CMlucVkZ.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
//#region extensions/google/video-generation-provider.ts
const DEFAULT_TIMEOUT_MS = 18e4;
const POLL_INTERVAL_MS = 1e4;
const MAX_POLL_ATTEMPTS = 120;
const GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE = "Google video generation response missing generated videos";
function resolveConfiguredGoogleVideoBaseUrl(req) {
	const configured = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
	return configured ? resolveGoogleGenerativeAiApiOrigin(configured) : void 0;
}
function resolveGoogleVideoRestBaseUrl(configuredBaseUrl) {
	return `${configuredBaseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta`;
}
function resolveGoogleVideoRestModelPath(model) {
	const trimmed = normalizeOptionalString(model) || "veo-3.1-fast-generate-preview";
	if (trimmed.startsWith("google/models/")) return trimmed.slice(7);
	if (trimmed.startsWith("models/")) return trimmed;
	if (trimmed.startsWith("google/")) return `models/${trimmed.slice(7)}`;
	return `models/${trimmed}`;
}
function parseVideoSize(size) {
	const trimmed = normalizeOptionalString(size);
	if (!trimmed) return;
	const match = /^(\d+)x(\d+)$/u.exec(trimmed);
	if (!match) return;
	const width = Number.parseInt(match[1] ?? "", 10);
	const height = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(width) || !Number.isFinite(height)) return;
	return {
		width,
		height
	};
}
function resolveAspectRatio(params) {
	const direct = normalizeOptionalString(params.aspectRatio);
	if (direct === "16:9" || direct === "9:16") return direct;
	const parsedSize = parseVideoSize(params.size);
	if (!parsedSize) return;
	return parsedSize.width >= parsedSize.height ? "16:9" : "9:16";
}
function resolveResolution(params) {
	if (params.resolution === "720P") return "720p";
	if (params.resolution === "1080P") return "1080p";
	const parsedSize = parseVideoSize(params.size);
	if (!parsedSize) return;
	const maxEdge = Math.max(parsedSize.width, parsedSize.height);
	return maxEdge >= 1920 ? "1080p" : maxEdge >= 1280 ? "720p" : void 0;
}
function resolveDurationSeconds(durationSeconds) {
	if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return;
	const rounded = Math.min(GOOGLE_VIDEO_MAX_DURATION_SECONDS, Math.max(GOOGLE_VIDEO_MIN_DURATION_SECONDS, Math.round(durationSeconds)));
	return GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.reduce((best, current) => {
		const currentDistance = Math.abs(current - rounded);
		const bestDistance = Math.abs(best - rounded);
		if (currentDistance < bestDistance) return current;
		if (currentDistance === bestDistance && current > best) return current;
		return best;
	});
}
function resolveInputImage(req) {
	const input = req.inputImages?.[0];
	if (!input?.buffer) return;
	return {
		imageBytes: input.buffer.toString("base64"),
		mimeType: normalizeOptionalString(input.mimeType) || "image/png"
	};
}
function resolveInputVideo(req) {
	const input = req.inputVideos?.[0];
	if (!input?.buffer) return;
	return {
		videoBytes: input.buffer.toString("base64"),
		mimeType: normalizeOptionalString(input.mimeType) || "video/mp4"
	};
}
async function downloadGeneratedVideo(params) {
	return await withTempWorkspace({
		rootDir: resolvePreferredOpenClawTmpDir(),
		prefix: "openclaw-google-video-"
	}, async ({ dir: tempDir }) => {
		const fileName = `video-${params.index + 1}.mp4`;
		const downloadPath = path.join(tempDir, fileName);
		await writeExternalFileWithinRoot({
			rootDir: tempDir,
			path: fileName,
			write: async (downloadPath) => {
				await executeProviderOperationWithRetry({
					provider: "google",
					stage: "download",
					operation: async () => {
						await params.client.files.download({
							file: params.file,
							downloadPath
						});
					}
				});
			}
		});
		return {
			buffer: await readFile(downloadPath),
			mimeType: "video/mp4",
			fileName: `video-${params.index + 1}.mp4`
		};
	});
}
function resolveGoogleGeneratedVideoDownloadUrl(params) {
	const trimmed = normalizeOptionalString(params.uri);
	if (!trimmed) return;
	let url;
	try {
		url = new URL(trimmed);
	} catch {
		return;
	}
	if (url.protocol !== "https:") return;
	const allowedOrigins = new Set(["https://generativelanguage.googleapis.com"]);
	if (params.configuredBaseUrl) try {
		const configuredOrigin = new URL(params.configuredBaseUrl).origin;
		if (configuredOrigin.startsWith("https://")) allowedOrigins.add(configuredOrigin);
	} catch {}
	if (!allowedOrigins.has(url.origin)) return;
	if (!url.searchParams.has("key")) url.searchParams.set("key", params.apiKey);
	return url.toString();
}
async function downloadGeneratedVideoFromUri(params) {
	const downloadUrl = resolveGoogleGeneratedVideoDownloadUrl({
		uri: params.uri,
		apiKey: params.apiKey,
		configuredBaseUrl: params.configuredBaseUrl
	});
	if (!downloadUrl) return;
	return await executeProviderOperationWithRetry({
		provider: "google",
		stage: "download",
		operation: async () => {
			const { response, release } = await fetchWithSsrFGuard({ url: downloadUrl });
			try {
				if (!response.ok) throw new Error(`Failed to download Google generated video: ${response.status} ${response.statusText}`);
				return {
					buffer: Buffer.from(await response.arrayBuffer()),
					mimeType: normalizeOptionalString(response.headers.get("content-type")) || normalizeOptionalString(params.mimeType) || "video/mp4",
					fileName: `video-${params.index + 1}.mp4`
				};
			} finally {
				await release();
			}
		}
	});
}
function extractGoogleApiErrorCode(error) {
	const status = error?.status;
	if (typeof status === "number") return status;
	const message = error instanceof Error ? error.message : String(error);
	try {
		const parsed = JSON.parse(message);
		const code = typeof parsed.code === "number" ? parsed.code : parsed.error?.code;
		return typeof code === "number" ? code : void 0;
	} catch {
		return /\b404\b/u.test(message) ? 404 : void 0;
	}
}
function extractGeneratedVideos(operation) {
	const response = operation.response;
	const generatedVideos = response?.generatedVideos;
	if (Array.isArray(generatedVideos) && generatedVideos.length > 0) return generatedVideos;
	const generatedSamples = (response?.generateVideoResponse)?.generatedSamples;
	return Array.isArray(generatedSamples) ? generatedSamples : [];
}
async function requestGoogleVideoJson(params) {
	function createHttpError(response, detail) {
		const parts = [`HTTP ${response.status}`];
		const statusText = response.statusText.trim();
		if (statusText) parts.push(statusText);
		if (typeof detail === "string") {
			const trimmed = detail.trim();
			if (trimmed) parts.push(trimmed);
		} else if (detail && typeof detail === "object") parts.push(JSON.stringify(detail));
		const error = new Error(parts.join(": "));
		Object.assign(error, {
			status: response.status,
			statusCode: response.status
		});
		return error;
	}
	return await executeProviderOperationWithRetry({
		provider: "google",
		stage: params.stage,
		operation: async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => {
				const error = /* @__PURE__ */ new Error("request timed out");
				error.name = "TimeoutError";
				controller.abort(error);
			}, resolveProviderOperationTimeoutMs({
				deadline: params.deadline,
				defaultTimeoutMs: DEFAULT_TIMEOUT_MS
			}));
			try {
				const { response, release } = await fetchWithSsrFGuard({
					url: params.url,
					init: {
						method: params.method,
						headers: params.headers,
						...params.body === void 0 ? {} : { body: JSON.stringify(params.body) }
					},
					signal: controller.signal
				});
				try {
					const text = await response.text();
					if (!response.ok) {
						let detail = text;
						if (text) try {
							detail = JSON.parse(text);
						} catch {
							detail = text;
						}
						throw createHttpError(response, detail);
					}
					return text ? JSON.parse(text) : {};
				} finally {
					await release();
				}
			} finally {
				clearTimeout(timeout);
			}
		}
	});
}
async function generateGoogleVideoViaRest(params) {
	let operation = await requestGoogleVideoJson({
		url: `${params.baseUrl}/${resolveGoogleVideoRestModelPath(params.model)}:predictLongRunning`,
		method: "POST",
		headers: params.headers,
		deadline: params.deadline,
		stage: "create",
		body: {
			instances: [{ prompt: params.prompt }],
			parameters: {
				...typeof params.durationSeconds === "number" ? { durationSeconds: params.durationSeconds } : {},
				...params.aspectRatio ? { aspectRatio: params.aspectRatio } : {},
				...params.resolution ? { resolution: params.resolution } : {}
			}
		}
	});
	for (let attempt = 0; !(operation.done ?? false); attempt += 1) {
		if (attempt >= MAX_POLL_ATTEMPTS) throw new Error("Google video generation did not finish in time");
		await waitProviderOperationPollInterval({
			deadline: params.deadline,
			pollIntervalMs: POLL_INTERVAL_MS
		});
		const operationName = operation.name;
		if (typeof operationName !== "string" || !operationName) throw new Error("Google video operation response missing name for polling");
		operation = await requestGoogleVideoJson({
			url: `${params.baseUrl}/${operationName}`,
			method: "GET",
			headers: params.headers,
			deadline: params.deadline,
			stage: "poll"
		});
	}
	const error = operation.error;
	if (error) throw new Error(JSON.stringify(error));
	return operation;
}
function buildGoogleVideoGenerationProvider() {
	return {
		...createGoogleVideoGenerationProviderMetadata(),
		async generateVideo(req) {
			if ((req.inputImages?.length ?? 0) > 1) throw new Error("Google video generation supports at most one input image.");
			if ((req.inputVideos?.length ?? 0) > 1) throw new Error("Google video generation supports at most one input video.");
			if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) throw new Error("Google video generation does not support image and video inputs together.");
			const auth = await resolveApiKeyForProvider({
				provider: "google",
				cfg: req.cfg,
				agentDir: req.agentDir,
				store: req.authStore
			});
			if (!auth.apiKey) throw new Error("Google API key missing");
			const apiKey = auth.apiKey;
			const configuredBaseUrl = resolveConfiguredGoogleVideoBaseUrl(req);
			const restBaseUrl = resolveGoogleVideoRestBaseUrl(configuredBaseUrl);
			const authHeaders = parseGeminiAuth(apiKey).headers;
			const durationSeconds = resolveDurationSeconds(req.durationSeconds);
			const model = normalizeOptionalString(req.model) || "veo-3.1-fast-generate-preview";
			const aspectRatio = resolveAspectRatio({
				aspectRatio: req.aspectRatio,
				size: req.size
			});
			const resolution = resolveResolution({
				resolution: req.resolution,
				size: req.size
			});
			const hasReferenceInputs = (req.inputImages?.length ?? 0) > 0 || (req.inputVideos?.length ?? 0) > 0;
			const deadline = createProviderOperationDeadline({
				timeoutMs: req.timeoutMs,
				label: "Google video generation"
			});
			const client = createGoogleGenAI({
				apiKey,
				httpOptions: {
					...configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {},
					timeout: resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					})
				}
			});
			let usedRestFallback = false;
			let operation;
			try {
				operation = await client.models.generateVideos({
					model,
					prompt: req.prompt,
					image: resolveInputImage(req),
					video: resolveInputVideo(req),
					config: {
						...typeof durationSeconds === "number" ? { durationSeconds } : {},
						...aspectRatio ? { aspectRatio } : {},
						...resolution ? { resolution } : {}
					}
				});
			} catch (error) {
				if (hasReferenceInputs || extractGoogleApiErrorCode(error) !== 404) throw error;
				usedRestFallback = true;
				operation = await generateGoogleVideoViaRest({
					baseUrl: restBaseUrl,
					headers: authHeaders,
					deadline,
					model,
					prompt: req.prompt,
					durationSeconds,
					aspectRatio,
					resolution
				});
			}
			if (!usedRestFallback) {
				let sdkOperation = operation;
				for (let attempt = 0; !(sdkOperation.done ?? false); attempt += 1) {
					if (attempt >= MAX_POLL_ATTEMPTS) throw new Error("Google video generation did not finish in time");
					await waitProviderOperationPollInterval({
						deadline,
						pollIntervalMs: POLL_INTERVAL_MS
					});
					resolveProviderOperationTimeoutMs({
						deadline,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS
					});
					sdkOperation = await executeProviderOperationWithRetry({
						provider: "google",
						stage: "poll",
						operation: () => client.operations.getVideosOperation({ operation: sdkOperation })
					});
				}
				operation = sdkOperation;
			}
			const finalOperation = operation;
			if (finalOperation.error) throw new Error(JSON.stringify(finalOperation.error));
			let generatedVideos = extractGeneratedVideos(operation);
			if (generatedVideos.length === 0 && !hasReferenceInputs && !usedRestFallback) {
				usedRestFallback = true;
				operation = await generateGoogleVideoViaRest({
					baseUrl: restBaseUrl,
					headers: authHeaders,
					deadline,
					model,
					prompt: req.prompt,
					durationSeconds,
					aspectRatio,
					resolution
				});
				generatedVideos = extractGeneratedVideos(operation);
			}
			if (generatedVideos.length === 0) throw new Error(GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE);
			return {
				videos: await Promise.all(generatedVideos.map(async (entry, index) => {
					const inline = entry.video;
					if (inline?.videoBytes) return {
						buffer: Buffer.from(inline.videoBytes, "base64"),
						mimeType: normalizeOptionalString(inline.mimeType) || "video/mp4",
						fileName: `video-${index + 1}.mp4`
					};
					const directDownload = await downloadGeneratedVideoFromUri({
						uri: inline?.uri,
						apiKey,
						configuredBaseUrl,
						mimeType: inline?.mimeType,
						index
					});
					if (directDownload) return directDownload;
					if (!inline) throw new Error("Google generated video missing file handle");
					return await downloadGeneratedVideo({
						client,
						file: inline,
						index
					});
				})),
				model,
				metadata: finalOperation.name ? { operationName: finalOperation.name } : void 0
			};
		}
	};
}
//#endregion
export { buildGoogleVideoGenerationProvider as t };
