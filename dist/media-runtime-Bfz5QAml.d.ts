import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { f as MediaUnderstandingConfig } from "./types.tools-BpgZArJS.js";
import { o as SsrFPolicy } from "./ssrf-skjEI_i5.js";
import { c as MediaAttachment, d as MediaUnderstandingOutput, f as MediaUnderstandingProvider, l as MediaUnderstandingCapability, u as MediaUnderstandingDecision } from "./types-ByzWuf9L.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { t as ActiveMediaModel } from "./active-model.types-DCiq_ik4.js";
import { t as OutboundSendDeps } from "./send-deps-BaEC80iY.js";
import { t as OutboundMediaAccess } from "./load-options-CTuppEe4.js";
import { n as ChannelOutboundAdapter } from "./outbound.types-D7agCOHK.js";
//#region src/media/audio-transcode.d.ts
declare function transcodeAudioBufferToOpus(params: {
  audioBuffer: Buffer;
  inputExtension?: string;
  inputFileName?: string;
  tempPrefix?: string;
  outputFileName?: string;
  timeoutMs?: number;
  sampleRateHz?: number;
  bitrate?: string;
  channels?: number;
}): Promise<Buffer>;
type AudioContainerTranscodeOutcome = {
  ok: true;
  buffer: Buffer;
} | {
  ok: false;
  reason: "platform-unsupported" | "invalid-extension" | "noop-same-container" | "no-recipe" | "transcoder-failed";
  detail?: string;
};
declare function transcodeAudioBuffer(params: {
  audioBuffer: Buffer;
  sourceExtension: string;
  targetExtension: string;
  timeoutMs?: number;
}): Promise<AudioContainerTranscodeOutcome>;
//#endregion
//#region src/media/ffmpeg-exec.d.ts
type MediaExecOptions = {
  timeoutMs?: number;
  maxBufferBytes?: number;
  input?: Buffer | string;
};
declare function runFfprobe(args: string[], options?: MediaExecOptions): Promise<string>;
declare function runFfmpeg(args: string[], options?: MediaExecOptions): Promise<string>;
declare function parseFfprobeCsvFields(stdout: string, maxFields: number): string[];
declare function parseFfprobeCodecAndSampleRate(stdout: string): {
  codec: string | null;
  sampleRateHz: number | null;
};
//#endregion
//#region src/media/video-dimensions.d.ts
type VideoDimensions = {
  width: number;
  height: number;
};
declare function parseFfprobeVideoDimensions(stdout: string): VideoDimensions | undefined;
declare function probeVideoDimensions(buffer: Buffer): Promise<VideoDimensions | undefined>;
//#endregion
//#region src/media/base64.d.ts
declare function estimateBase64DecodedBytes(base64: string): number;
/**
 * Normalize and validate a base64 string.
 * Returns canonical base64 (no whitespace) or undefined when invalid.
 */
declare function canonicalizeBase64(base64: string): string | undefined;
//#endregion
//#region src/media/ffmpeg-limits.d.ts
declare const MEDIA_FFMPEG_MAX_BUFFER_BYTES: number;
declare const MEDIA_FFPROBE_TIMEOUT_MS = 10000;
declare const MEDIA_FFMPEG_TIMEOUT_MS = 45000;
declare const MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS: number;
//#endregion
//#region src/media/outbound-attachment.d.ts
declare function resolveOutboundAttachmentFromUrl(mediaUrl: string, maxBytes: number, options?: {
  mediaAccess?: OutboundMediaAccess;
  localRoots?: readonly string[];
  readFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{
  path: string;
  contentType?: string;
}>;
//#endregion
//#region src/media/qr-image.d.ts
type QrPngRenderOptions = {
  scale?: number;
  marginModules?: number;
};
type QrPngTempFileOptions = QrPngRenderOptions & {
  tmpRoot: string;
  dirPrefix: string;
  fileName?: string;
};
type QrPngTempFile = {
  filePath: string;
  dirPath: string;
  mediaLocalRoots: string[];
};
declare function renderQrPngBase64(input: string, opts?: QrPngRenderOptions): Promise<string>;
declare function formatQrPngDataUrl(base64: string): string;
declare function renderQrPngDataUrl(input: string, opts?: QrPngRenderOptions): Promise<string>;
declare function writeQrPngTempFile(input: string, opts: QrPngTempFileOptions): Promise<QrPngTempFile>;
//#endregion
//#region src/media/qr-terminal.d.ts
declare function renderQrTerminal(input: string, opts?: {
  small?: boolean;
}): Promise<string>;
//#endregion
//#region src/media/temp-files.d.ts
declare function unlinkIfExists(filePath: string | null | undefined): Promise<void>;
//#endregion
//#region src/channels/plugins/media-limits.d.ts
declare function resolveChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  resolveChannelLimitMb: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => number | undefined;
  accountId?: string | null;
}): number | undefined;
//#endregion
//#region src/media-understanding/audio-preflight.d.ts
/**
 * Transcribes the first audio attachment BEFORE mention checking.
 * This allows voice notes to be processed in group chats with requireMention: true.
 * Returns the transcript or undefined if transcription fails or no audio is found.
 */
declare function transcribeFirstAudio(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<string | undefined>;
//#endregion
//#region src/media-understanding/defaults.constants.d.ts
declare const DEFAULT_MAX_CHARS = 500;
declare const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<MediaUnderstandingCapability, number | undefined>;
declare const DEFAULT_MAX_BYTES: Record<MediaUnderstandingCapability, number>;
declare const DEFAULT_TIMEOUT_SECONDS: Record<MediaUnderstandingCapability, number>;
declare const DEFAULT_PROMPT: Record<MediaUnderstandingCapability, string>;
declare const DEFAULT_VIDEO_MAX_BASE64_BYTES: number;
declare const CLI_OUTPUT_MAX_BUFFER: number;
declare const DEFAULT_MEDIA_CONCURRENCY = 2;
declare const MIN_AUDIO_FILE_BYTES = 1024;
//#endregion
//#region src/media-understanding/defaults.d.ts
declare function resolveDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
  includeConfiguredImageModels?: boolean;
}): string | undefined;
declare function resolveAutoMediaKeyProviders(params: {
  capability: MediaUnderstandingCapability;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string[];
declare function providerSupportsNativePdfDocument(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): boolean;
//#endregion
//#region src/media-understanding/attachments.cache.d.ts
type MediaBufferResult = {
  buffer: Buffer;
  mime?: string;
  fileName: string;
  size: number;
};
type MediaPathResult = {
  path: string;
  cleanup?: () => Promise<void> | void;
};
type MediaAttachmentCacheOptions = {
  localPathRoots?: readonly string[];
  includeDefaultLocalPathRoots?: boolean;
  ssrfPolicy?: SsrFPolicy;
  workspaceDir?: string;
};
declare class MediaAttachmentCache {
  private readonly entries;
  private readonly attachments;
  private readonly localPathRoots;
  private readonly ssrfPolicy;
  private readonly workspaceDir?;
  private canonicalLocalPathRoots?;
  constructor(attachments: MediaAttachment[], options?: MediaAttachmentCacheOptions);
  getBuffer(params: {
    attachmentIndex: number;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<MediaBufferResult>;
  getPath(params: {
    attachmentIndex: number;
    maxBytes?: number;
    timeoutMs: number;
  }): Promise<MediaPathResult>;
  cleanup(): Promise<void>;
  private ensureEntry;
  private resolveLocalPath;
  private ensureLocalStat;
  private getCanonicalLocalPathRoots;
  private readLocalBuffer;
}
//#endregion
//#region src/media-understanding/runner.attachments.d.ts
declare function normalizeMediaAttachments(ctx: MsgContext): MediaAttachment[];
declare function createMediaAttachmentCache(attachments: MediaAttachment[], options?: MediaAttachmentCacheOptions): MediaAttachmentCache;
//#endregion
//#region src/media-understanding/runner.d.ts
type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
type RunCapabilityResult = {
  outputs: MediaUnderstandingOutput[];
  decision: MediaUnderstandingDecision;
};
declare function buildProviderRegistry(overrides?: Record<string, MediaUnderstandingProvider>, cfg?: OpenClawConfig): ProviderRegistry;
declare function resolveMediaAttachmentLocalRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  workspaceDir?: string;
}): readonly string[];
declare function clearMediaUnderstandingBinaryCacheForTests(): void;
declare function resolveAutoImageModel(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  activeModel?: ActiveMediaModel;
}): Promise<ActiveMediaModel | null>;
declare function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachments: MediaAttachmentCache;
  media: MediaAttachment[];
  agentDir?: string;
  workspaceDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
}): Promise<RunCapabilityResult>;
//#endregion
//#region src/media-understanding/provider-id.d.ts
declare function normalizeMediaProviderId(id: string): string;
//#endregion
//#region src/channels/plugins/outbound/direct-text-media.d.ts
type DirectSendOptions = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  replyToId?: string | null;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
};
type DirectSendResult = {
  messageId: string;
  [key: string]: unknown;
};
type DirectSendFn<TOpts extends Record<string, unknown>, TResult extends DirectSendResult> = (to: string, text: string, opts: TOpts) => Promise<TResult>;
declare function resolveScopedChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  resolveChannelLimitMb: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => number | undefined;
}): number | undefined;
declare function createScopedChannelMediaMaxBytesResolver(channel: string): (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => number | undefined;
declare function createDirectTextMediaOutbound<TOpts extends Record<string, unknown>, TResult extends DirectSendResult>(params: {
  channel: string;
  resolveSender: (deps: OutboundSendDeps | undefined) => DirectSendFn<TOpts, TResult>;
  resolveMaxBytes: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => number | undefined;
  buildTextOptions: (params: DirectSendOptions) => TOpts;
  buildMediaOptions: (params: DirectSendOptions) => TOpts;
}): ChannelOutboundAdapter;
//#endregion
export { renderQrPngBase64 as A, VideoDimensions as B, DEFAULT_VIDEO_MAX_BASE64_BYTES as C, unlinkIfExists as D, resolveChannelMediaMaxBytes as E, MEDIA_FFMPEG_MAX_BUFFER_BYTES as F, parseFfprobeCsvFields as G, probeVideoDimensions as H, MEDIA_FFMPEG_TIMEOUT_MS as I, AudioContainerTranscodeOutcome as J, runFfmpeg as K, MEDIA_FFPROBE_TIMEOUT_MS as L, writeQrPngTempFile as M, resolveOutboundAttachmentFromUrl as N, renderQrTerminal as O, MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS as P, canonicalizeBase64 as R, DEFAULT_TIMEOUT_SECONDS as S, transcribeFirstAudio as T, MediaExecOptions as U, parseFfprobeVideoDimensions as V, parseFfprobeCodecAndSampleRate as W, transcodeAudioBufferToOpus as X, transcodeAudioBuffer as Y, DEFAULT_MAX_BYTES as _, RunCapabilityResult as a, DEFAULT_MEDIA_CONCURRENCY as b, resolveAutoImageModel as c, createMediaAttachmentCache as d, normalizeMediaAttachments as f, CLI_OUTPUT_MAX_BUFFER as g, resolveDefaultMediaModel as h, normalizeMediaProviderId as i, renderQrPngDataUrl as j, formatQrPngDataUrl as k, resolveMediaAttachmentLocalRoots as l, resolveAutoMediaKeyProviders as m, createScopedChannelMediaMaxBytesResolver as n, buildProviderRegistry as o, providerSupportsNativePdfDocument as p, runFfprobe as q, resolveScopedChannelMediaMaxBytes as r, clearMediaUnderstandingBinaryCacheForTests as s, createDirectTextMediaOutbound as t, runCapability as u, DEFAULT_MAX_CHARS as v, MIN_AUDIO_FILE_BYTES as w, DEFAULT_PROMPT as x, DEFAULT_MAX_CHARS_BY_CAPABILITY as y, estimateBase64DecodedBytes as z };