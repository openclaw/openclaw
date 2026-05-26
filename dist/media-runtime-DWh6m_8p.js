import { r as writeExternalFileWithinRoot } from "./fs-safe-DpJlqO1z.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C5ctwRKD.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-CouSpJO4.js";
import { r as withTempWorkspace, t as tempWorkspace } from "./private-temp-workspace-CS7i2diZ.js";
import "./mime-Bg_OIUJn.js";
import { x as sendTextMediaPayload } from "./reply-payload-BOrd8HRU.js";
import "./image-ops-CL9ZQP7k.js";
import "./store-b792nN7l.js";
import "./fetch-zuIYqxzf.js";
import "./local-roots-BDXF9cWN.js";
import "./local-media-access-z1nEwng6.js";
import "./defaults-C7Hv5EKy.js";
import "./image-runtime-pndfllVY.js";
import "./defaults.constants-CRZ3dal0.js";
import { a as runCapability, i as resolveMediaAttachmentLocalRoots, l as isAudioAttachment, o as createMediaAttachmentCache, s as normalizeMediaAttachments, t as buildProviderRegistry } from "./runner-DjFT6is3.js";
import { d as runFfprobe, u as runFfmpeg } from "./runner.entries-BW-r9RsX.js";
import { a as chunkText } from "./chunk-CGVwhsnj.js";
import { t as sanitizeForPlainText } from "./sanitize-text-QuMt6r4k.js";
import { n as sendTranscriptEcho } from "./echo-transcript-DGohbhvN.js";
import "./audio-u97wmFSv.js";
import "./agent-media-payload-CX6sNvDd.js";
import "./outbound-runtime-HTtq1b9m.js";
import "./outbound-attachment-kr1-eQfF.js";
import "./png-encode-BtNm4GjM.js";
import { n as loadQrCodeRuntime, r as normalizeQrText } from "./qr-terminal-DPbzJFls.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/media/audio-transcode.ts
const DEFAULT_OPUS_SAMPLE_RATE_HZ = 48e3;
const DEFAULT_OPUS_BITRATE = "64k";
const DEFAULT_OPUS_CHANNELS = 1;
const DEFAULT_TEMP_PREFIX = "audio-opus-";
const DEFAULT_OUTPUT_FILE_NAME = "voice.opus";
function normalizeAudioExtension(params) {
	const fromExtension = params.inputExtension?.trim();
	const normalized = (fromExtension ? fromExtension.startsWith(".") ? fromExtension : `.${fromExtension}` : path.extname(params.inputFileName ?? "")).toLowerCase();
	return /^\.[a-z0-9]{1,12}$/.test(normalized) ? normalized : ".audio";
}
function normalizeTempPrefix(value) {
	const sanitized = value?.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!sanitized || sanitized === "." || sanitized === "..") return DEFAULT_TEMP_PREFIX;
	return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}
function normalizeOutputFileName(value) {
	const baseName = path.basename(value?.trim() || DEFAULT_OUTPUT_FILE_NAME);
	if (/^[a-zA-Z0-9._-]{1,80}$/.test(baseName) && baseName !== "." && baseName !== "..") return baseName;
	return DEFAULT_OUTPUT_FILE_NAME;
}
async function transcodeAudioBufferToOpus(params) {
	return await withTempWorkspace({
		rootDir: resolvePreferredOpenClawTmpDir(),
		prefix: normalizeTempPrefix(params.tempPrefix)
	}, async (workspace) => {
		const inputPath = await workspace.write(`input${normalizeAudioExtension(params)}`, params.audioBuffer);
		const outputFileName = normalizeOutputFileName(params.outputFileName);
		await writeExternalFileWithinRoot({
			rootDir: workspace.dir,
			path: outputFileName,
			write: async (outputPath) => {
				await runFfmpeg([
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-i",
					inputPath,
					"-vn",
					"-sn",
					"-dn",
					"-c:a",
					"libopus",
					"-b:a",
					params.bitrate ?? DEFAULT_OPUS_BITRATE,
					"-ar",
					String(params.sampleRateHz ?? DEFAULT_OPUS_SAMPLE_RATE_HZ),
					"-ac",
					String(params.channels ?? DEFAULT_OPUS_CHANNELS),
					"-f",
					"opus",
					outputPath
				], { timeoutMs: params.timeoutMs });
			}
		});
		return await workspace.read(outputFileName);
	});
}
//#endregion
//#region src/media/qr-image.ts
const DEFAULT_QR_PNG_SCALE = 6;
const DEFAULT_QR_PNG_MARGIN_MODULES = 4;
const MIN_QR_PNG_SCALE = 1;
const MAX_QR_PNG_SCALE = 12;
const MIN_QR_PNG_MARGIN_MODULES = 0;
const MAX_QR_PNG_MARGIN_MODULES = 16;
const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";
function resolveQrPngIntegerOption(params) {
	if (params.value === void 0) return params.defaultValue;
	if (!Number.isFinite(params.value)) throw new RangeError(`${params.name} must be a finite number.`);
	const value = Math.floor(params.value);
	if (value < params.min || value > params.max) throw new RangeError(`${params.name} must be between ${params.min} and ${params.max}.`);
	return value;
}
function resolveQrTempPathSegment(name, value) {
	if (!value || value === "." || value === ".." || path.basename(value) !== value) throw new RangeError(`${name} must be a non-empty filename segment.`);
	return value;
}
async function renderQrPngBase64(input, opts = {}) {
	const scale = resolveQrPngIntegerOption({
		name: "scale",
		value: opts.scale,
		defaultValue: DEFAULT_QR_PNG_SCALE,
		min: MIN_QR_PNG_SCALE,
		max: MAX_QR_PNG_SCALE
	});
	const marginModules = resolveQrPngIntegerOption({
		name: "marginModules",
		value: opts.marginModules,
		defaultValue: DEFAULT_QR_PNG_MARGIN_MODULES,
		min: MIN_QR_PNG_MARGIN_MODULES,
		max: MAX_QR_PNG_MARGIN_MODULES
	});
	const dataUrl = await (await loadQrCodeRuntime()).toDataURL(normalizeQrText(input), {
		margin: marginModules,
		scale,
		type: "image/png"
	});
	if (!dataUrl.startsWith(QR_PNG_DATA_URL_PREFIX)) throw new Error("Expected qrcode to return a PNG data URL.");
	return dataUrl.slice(22);
}
function formatQrPngDataUrl(base64) {
	return `${QR_PNG_DATA_URL_PREFIX}${base64}`;
}
async function renderQrPngDataUrl(input, opts = {}) {
	return formatQrPngDataUrl(await renderQrPngBase64(input, opts));
}
async function writeQrPngTempFile(input, opts) {
	const dirPrefix = resolveQrTempPathSegment("dirPrefix", opts.dirPrefix);
	const fileName = resolveQrTempPathSegment("fileName", opts.fileName ?? "qr.png");
	const pngBase64 = await renderQrPngBase64(input, opts);
	const workspace = await tempWorkspace({
		rootDir: opts.tmpRoot,
		prefix: dirPrefix
	});
	const dirPath = workspace.dir;
	try {
		return {
			filePath: await workspace.write(fileName, Buffer.from(pngBase64, "base64")),
			dirPath,
			mediaLocalRoots: [dirPath]
		};
	} catch (err) {
		await workspace.cleanup();
		throw err;
	}
}
//#endregion
//#region src/media/temp-files.ts
async function unlinkIfExists(filePath) {
	if (!filePath) return;
	try {
		await fs.unlink(filePath);
	} catch {}
}
//#endregion
//#region src/media/video-dimensions.ts
function parsePositiveDimension(value) {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return;
	return value;
}
function parseFfprobeVideoDimensions(stdout) {
	const stream = JSON.parse(stdout).streams?.[0];
	const width = parsePositiveDimension(stream?.width);
	const height = parsePositiveDimension(stream?.height);
	return width && height ? {
		width,
		height
	} : void 0;
}
async function probeVideoDimensions(buffer) {
	try {
		return parseFfprobeVideoDimensions(await runFfprobe([
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height",
			"-of",
			"json",
			"pipe:0"
		], { input: buffer }));
	} catch {
		return;
	}
}
//#endregion
//#region src/channels/plugins/media-limits.ts
const MB = 1024 * 1024;
function resolveChannelMediaMaxBytes(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelLimit = params.resolveChannelLimitMb({
		cfg: params.cfg,
		accountId
	});
	if (channelLimit) return channelLimit * MB;
	if (params.cfg.agents?.defaults?.mediaMaxMb) return params.cfg.agents.defaults.mediaMaxMb * MB;
}
//#endregion
//#region src/media-understanding/audio-transcription-runner.ts
async function runAudioTranscription(params) {
	const attachments = params.attachments ?? normalizeMediaAttachments(params.ctx);
	if (attachments.length === 0) return {
		transcript: void 0,
		attachments
	};
	const providerRegistry = buildProviderRegistry(params.providers, params.cfg);
	const cache = createMediaAttachmentCache(attachments, {
		...params.localPathRoots ? { localPathRoots: params.localPathRoots } : {},
		ssrfPolicy: params.cfg.tools?.web?.fetch?.ssrfPolicy
	});
	try {
		return {
			transcript: (await runCapability({
				capability: "audio",
				cfg: params.cfg,
				ctx: params.ctx,
				attachments: cache,
				media: attachments,
				agentDir: params.agentDir,
				providerRegistry,
				config: params.cfg.tools?.media?.audio,
				activeModel: params.activeModel
			})).outputs.find((entry) => entry.kind === "audio.transcription")?.text?.trim() || void 0,
			attachments
		};
	} finally {
		await cache.cleanup();
	}
}
//#endregion
//#region src/media-understanding/audio-preflight.ts
/**
* Transcribes the first audio attachment BEFORE mention checking.
* This allows voice notes to be processed in group chats with requireMention: true.
* Returns the transcript or undefined if transcription fails or no audio is found.
*/
async function transcribeFirstAudio(params) {
	const { ctx, cfg } = params;
	const audioConfig = cfg.tools?.media?.audio;
	if (audioConfig?.enabled === false) return;
	const attachments = normalizeMediaAttachments(ctx);
	if (!attachments || attachments.length === 0) return;
	const firstAudio = attachments.find((att) => att && isAudioAttachment(att) && !att.alreadyTranscribed);
	if (!firstAudio) return;
	if (shouldLogVerbose()) logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
	try {
		const { transcript } = await runAudioTranscription({
			ctx,
			cfg,
			attachments,
			agentDir: params.agentDir,
			providers: params.providers,
			activeModel: params.activeModel,
			localPathRoots: resolveMediaAttachmentLocalRoots({
				cfg,
				ctx
			})
		});
		if (!transcript) return;
		if (audioConfig?.echoTranscript) await sendTranscriptEcho({
			ctx,
			cfg,
			transcript,
			format: audioConfig.echoFormat ?? "📝 \"{transcript}\""
		});
		firstAudio.alreadyTranscribed = true;
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcribed ${transcript.length} chars from attachment ${firstAudio.index}`);
		return transcript;
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
		return;
	}
}
//#endregion
//#region src/channels/plugins/outbound/direct-text-media.ts
function resolveScopedChannelMediaMaxBytes(params) {
	return resolveChannelMediaMaxBytes({
		cfg: params.cfg,
		resolveChannelLimitMb: params.resolveChannelLimitMb,
		accountId: params.accountId
	});
}
function createScopedChannelMediaMaxBytesResolver(channel) {
	return (params) => resolveScopedChannelMediaMaxBytes({
		cfg: params.cfg,
		accountId: params.accountId,
		resolveChannelLimitMb: ({ cfg, accountId }) => (cfg.channels?.[channel]?.accounts?.[accountId])?.mediaMaxMb ?? cfg.channels?.[channel]?.mediaMaxMb
	});
}
function createDirectTextMediaOutbound(params) {
	const sendDirect = async (sendParams) => {
		const send = params.resolveSender(sendParams.deps);
		const maxBytes = params.resolveMaxBytes({
			cfg: sendParams.cfg,
			accountId: sendParams.accountId
		});
		const result = await send(sendParams.to, sendParams.text, sendParams.buildOptions({
			cfg: sendParams.cfg,
			mediaUrl: sendParams.mediaUrl,
			mediaAccess: sendParams.mediaAccess,
			mediaLocalRoots: sendParams.mediaAccess?.localRoots,
			mediaReadFile: sendParams.mediaAccess?.readFile,
			accountId: sendParams.accountId,
			replyToId: sendParams.replyToId,
			maxBytes
		}));
		return {
			channel: params.channel,
			...result
		};
	};
	const outbound = {
		deliveryMode: "direct",
		chunker: chunkText,
		chunkerMode: "text",
		textChunkLimit: 4e3,
		sanitizeText: ({ text }) => sanitizeForPlainText(text),
		sendPayload: async (ctx) => await sendTextMediaPayload({
			channel: params.channel,
			ctx,
			adapter: outbound
		}),
		sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
			return await sendDirect({
				cfg,
				to,
				text,
				accountId,
				deps,
				replyToId,
				buildOptions: params.buildTextOptions
			});
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile, accountId, deps, replyToId }) => {
			return await sendDirect({
				cfg,
				to,
				text,
				mediaUrl,
				mediaAccess: mediaAccess ?? (mediaLocalRoots || mediaReadFile ? {
					...mediaLocalRoots?.length ? { localRoots: mediaLocalRoots } : {},
					...mediaReadFile ? { readFile: mediaReadFile } : {}
				} : void 0),
				accountId,
				deps,
				replyToId,
				buildOptions: params.buildMediaOptions
			});
		}
	};
	return outbound;
}
//#endregion
export { resolveChannelMediaMaxBytes as a, unlinkIfExists as c, renderQrPngDataUrl as d, writeQrPngTempFile as f, transcribeFirstAudio as i, formatQrPngDataUrl as l, createScopedChannelMediaMaxBytesResolver as n, parseFfprobeVideoDimensions as o, transcodeAudioBufferToOpus as p, resolveScopedChannelMediaMaxBytes as r, probeVideoDimensions as s, createDirectTextMediaOutbound as t, renderQrPngBase64 as u };
