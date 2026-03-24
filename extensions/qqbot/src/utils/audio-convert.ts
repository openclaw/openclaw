import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { decode, encode, isSilk } from "silk-wasm";
import { debugLog, debugError, debugWarn } from "./debug-log.js";
import { detectFfmpeg, isWindows } from "./platform.js";

/**
 * 检查文件是否为 SILK 格式（QQ/微信语音常用格式）
 * QQ 语音文件通常以 .amr 扩展名保存，但实际编码可能是 SILK v3
 * SILK 文件头部标识: 0x02 "#!SILK_V3"
 */
function isSilkFile(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    return isSilk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return false;
  }
}

/**
 * 将 PCM (s16le) 数据封装为 WAV 文件格式
 * WAV = 44 字节 RIFF 头 + PCM 原始数据
 */
function pcmToWav(
  pcmData: Uint8Array,
  sampleRate: number,
  channels: number = 1,
  bitsPerSample: number = 16,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  // fmt sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

/**
 * 去除 QQ 语音文件的 AMR 头（如果存在）
 * QQ 的 .amr 文件可能在 SILK 数据前有 "#!AMR\n" 头（6 字节）
 * 需要去除后才能被 silk-wasm 正确解码
 */
function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/**
 * 将 SILK/AMR 语音文件转换为 WAV 格式
 *
 * @param inputPath 输入文件路径（.amr / .silk / .slk）
 * @param outputDir 输出目录（默认与输入文件同目录）
 * @returns 转换后的 WAV 文件路径，失败返回 null
 */
export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);

  // 去除可能的 AMR 头
  const strippedBuf = stripAmrHeader(fileBuf);

  // 转为 Uint8Array 以兼容 silk-wasm 类型要求
  const rawData = new Uint8Array(
    strippedBuf.buffer,
    strippedBuf.byteOffset,
    strippedBuf.byteLength,
  );

  // 验证是否为 SILK 格式
  if (!isSilk(rawData)) {
    return null;
  }

  // SILK 解码为 PCM (s16le)
  // QQ 语音通常采样率为 24000Hz
  const sampleRate = 24000;
  const result = await decode(rawData, sampleRate);

  // PCM → WAV
  const wavBuffer = pcmToWav(result.data, sampleRate);

  // 写入 WAV 文件
  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}

/**
 * 判断是否为语音附件（根据 content_type 或文件扩展名）
 */
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) {
    return true;
  }
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".amr", ".silk", ".slk", ".slac"].includes(ext);
}

/**
 * 格式化语音时长为可读字符串
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}分${remainSeconds}秒` : `${minutes}分钟`;
}

export function isAudioFile(filePath: string, mimeType?: string): boolean {
  // MIME 优先判断（解决无扩展名或扩展名不匹配的问题）
  if (mimeType) {
    if (mimeType === "voice" || mimeType.startsWith("audio/")) return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  return [
    ".silk",
    ".slk",
    ".amr",
    ".wav",
    ".mp3",
    ".ogg",
    ".opus",
    ".aac",
    ".flac",
    ".m4a",
    ".wma",
    ".pcm",
  ].includes(ext);
}

/** QQ 平台原生支持的语音 MIME 类型（不需要转码） */
const QQ_NATIVE_VOICE_MIMES = new Set([
  "audio/silk",
  "audio/amr",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
]);

/** QQ 平台原生支持的语音扩展名（不需要转码） */
const QQ_NATIVE_VOICE_EXTS = new Set([".silk", ".slk", ".amr", ".wav", ".mp3"]);

/**
 * 判断语音是否需要转码（参考企微 wecom-app 的 shouldTranscodeWecomVoice）
 *
 * QQ Bot API 原生支持 WAV/MP3/SILK 三种格式，其他格式需要先转码。
 * 使用 MIME + 扩展名双重判断，避免仅靠扩展名导致误判。
 *
 * @param filePath 音频文件路径
 * @param mimeType 可选的 MIME 类型
 * @returns true 表示需要转码，false 表示可以直传
 */
export function shouldTranscodeVoice(filePath: string, mimeType?: string): boolean {
  // MIME 优先：如果 MIME 是 QQ 原生支持的格式，不需要转码
  if (mimeType && QQ_NATIVE_VOICE_MIMES.has(mimeType.toLowerCase())) {
    return false;
  }
  // 扩展名判断
  const ext = path.extname(filePath).toLowerCase();
  if (QQ_NATIVE_VOICE_EXTS.has(ext)) {
    return false;
  }
  // 是音频但不是原生格式 → 需要转码
  return isAudioFile(filePath, mimeType);
}

// ============ TTS（文字转语音）============

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  /** Azure OpenAI 风格：使用 api-key header 而非 Bearer token */
  authStyle?: "bearer" | "api-key";
  /** 附加在 URL 后的查询参数，如 Azure 的 api-version */
  queryParams?: Record<string, string>;
  /** 自定义速度（默认不传） */
  speed?: number;
}

function resolveTTSFromBlock(
  block: Record<string, any>,
  providerCfg: Record<string, any> | undefined,
): TTSConfig | null {
  const baseUrl: string | undefined = block?.baseUrl || providerCfg?.baseUrl;
  const apiKey: string | undefined = block?.apiKey || providerCfg?.apiKey;
  const model: string = block?.model || "tts-1";
  const voice: string = block?.voice || "alloy";
  if (!baseUrl || !apiKey) return null;

  const authStyle =
    (block?.authStyle || providerCfg?.authStyle) === "api-key"
      ? ("api-key" as const)
      : ("bearer" as const);
  const queryParams: Record<string, string> = {
    ...(providerCfg?.queryParams ?? {}),
    ...(block?.queryParams ?? {}),
  };
  const speed: number | undefined = block?.speed;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    voice,
    authStyle,
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null {
  const c = cfg as any;

  // 优先使用 channels.qqbot.tts（插件专属配置）
  const channelTts = c?.channels?.qqbot?.tts;
  if (channelTts && channelTts.enabled !== false) {
    const providerId: string = channelTts?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const result = resolveTTSFromBlock(channelTts, providerCfg);
    if (result) return result;
  }

  // 回退到 messages.tts（openclaw 框架级 TTS 配置）
  const msgTts = c?.messages?.tts;
  if (msgTts && msgTts.auto !== "disabled") {
    const providerId: string = msgTts?.provider || "openai";
    const providerBlock = msgTts?.[providerId];
    const providerCfg = c?.models?.providers?.[providerId];
    const result = resolveTTSFromBlock(providerBlock ?? {}, providerCfg);
    if (result) return result;
  }

  return null;
}

/**
 * 构建 TTS 请求 URL 和 Headers
 * 支持 OpenAI 标准和 Azure OpenAI 两种风格
 */
function buildTTSRequest(ttsCfg: TTSConfig): { url: string; headers: Record<string, string> } {
  // 构建 URL：baseUrl + /audio/speech + 可选 queryParams
  let url = `${ttsCfg.baseUrl}/audio/speech`;
  if (ttsCfg.queryParams && Object.keys(ttsCfg.queryParams).length > 0) {
    const qs = new URLSearchParams(ttsCfg.queryParams).toString();
    url += `?${qs}`;
  }

  // 构建认证 Header
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ttsCfg.authStyle === "api-key") {
    headers["api-key"] = ttsCfg.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${ttsCfg.apiKey}`;
  }

  return { url, headers };
}

export async function textToSpeechPCM(
  text: string,
  ttsCfg: TTSConfig,
): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  const sampleRate = 24000;
  const { url, headers } = buildTTSRequest(ttsCfg);

  debugLog(
    `[tts] Request: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, url=${url}`,
  );
  debugLog(
    `[tts] Input text (${text.length} chars): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
  );

  // 先尝试 PCM 格式（最高质量，无需二次转码）
  const formats: Array<{ format: string; needsDecode: boolean }> = [
    { format: "pcm", needsDecode: false },
    { format: "mp3", needsDecode: true },
  ];

  let lastError: Error | null = null;
  const startTime = Date.now();

  for (const { format, needsDecode } of formats) {
    const controller = new AbortController();
    const ttsTimeout = setTimeout(() => controller.abort(), 120000);

    try {
      const body: Record<string, unknown> = {
        model: ttsCfg.model,
        input: text,
        voice: ttsCfg.voice,
        response_format: format,
        ...(format === "pcm" ? { sample_rate: sampleRate } : {}),
        ...(ttsCfg.speed !== undefined ? { speed: ttsCfg.speed } : {}),
      };

      debugLog(`[tts] Trying format=${format}...`);
      const fetchStart = Date.now();
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(ttsTimeout));

      const fetchMs = Date.now() - fetchStart;

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        debugLog(
          `[tts] HTTP ${resp.status} for format=${format} (${fetchMs}ms): ${detail.slice(0, 200)}`,
        );
        // 如果 PCM 不支持（Azure 等），回退到 mp3
        if (format === "pcm" && (resp.status === 400 || resp.status === 422)) {
          debugLog(`[tts] PCM format not supported, falling back to mp3`);
          lastError = new Error(`TTS PCM not supported: ${detail.slice(0, 200)}`);
          continue;
        }
        throw new Error(`TTS failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      const rawBuffer = Buffer.from(arrayBuffer);
      debugLog(
        `[tts] Response OK: format=${format}, size=${rawBuffer.length} bytes, latency=${fetchMs}ms`,
      );

      if (!needsDecode) {
        debugLog(
          `[tts] Done: PCM direct, ${rawBuffer.length} bytes, total=${Date.now() - startTime}ms`,
        );
        return { pcmBuffer: rawBuffer, sampleRate };
      }

      // mp3 需要解码为 PCM
      debugLog(`[tts] Decoding mp3 response (${rawBuffer.length} bytes) to PCM...`);
      const tmpDir = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tts-")));
      const tmpMp3 = path.join(tmpDir, "tts.mp3");
      fs.writeFileSync(tmpMp3, rawBuffer);

      try {
        // 优先用 ffmpeg
        const ffmpegCmd = await checkFfmpeg();
        if (ffmpegCmd) {
          const pcmBuf = await ffmpegToPCM(ffmpegCmd, tmpMp3, sampleRate);
          debugLog(
            `[tts] Done: mp3→PCM (ffmpeg), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`,
          );
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        // WASM fallback
        const pcmBuf = await wasmDecodeMp3ToPCM(rawBuffer, sampleRate);
        if (pcmBuf) {
          debugLog(
            `[tts] Done: mp3→PCM (wasm), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`,
          );
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        throw new Error("No decoder available for mp3 (install ffmpeg for best compatibility)");
      } finally {
        try {
          fs.unlinkSync(tmpMp3);
          fs.rmdirSync(tmpDir);
        } catch {}
      }
    } catch (err) {
      clearTimeout(ttsTimeout);
      lastError = err instanceof Error ? err : new Error(String(err));
      debugLog(`[tts] Error for format=${format}: ${lastError.message.slice(0, 200)}`);
      if (format === "pcm") {
        // PCM 失败时不立即抛出，尝试 mp3
        continue;
      }
      throw lastError;
    }
  }

  debugLog(`[tts] All formats exhausted after ${Date.now() - startTime}ms`);
  throw lastError ?? new Error("TTS failed: all formats exhausted");
}

export async function pcmToSilk(
  pcmBuffer: Buffer,
  sampleRate: number,
): Promise<{ silkBuffer: Buffer; duration: number }> {
  const pcmData = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const result = await encode(pcmData, sampleRate);
  return {
    silkBuffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    duration: result.duration,
  };
}

export async function textToSilk(
  text: string,
  ttsCfg: TTSConfig,
  outputDir: string,
): Promise<{ silkPath: string; silkBase64: string; duration: number }> {
  const { pcmBuffer, sampleRate } = await textToSpeechPCM(text, ttsCfg);
  const { silkBuffer, duration } = await pcmToSilk(pcmBuffer, sampleRate);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const silkPath = path.join(outputDir, `tts-${Date.now()}.silk`);
  fs.writeFileSync(silkPath, silkBuffer);

  return { silkPath, silkBase64: silkBuffer.toString("base64"), duration };
}

// ============ 核心：任意音频 → SILK Base64 ============

/** QQ Bot API 原生支持上传的音频格式（无需转换为 SILK） */
const QQ_NATIVE_UPLOAD_FORMATS = [".wav", ".mp3", ".silk"];

/**
 * 将本地音频文件转换为 QQ Bot 可上传的 Base64
 *
 * QQ Bot API 支持直传 WAV、MP3、SILK 三种格式，其他格式仍需转换。
 * 转换策略（参考 NapCat/go-cqhttp/Discord/Telegram 的做法）：
 *
 * 1. WAV / MP3 / SILK → 直传（跳过转换）
 * 2. 有 ffmpeg → ffmpeg 万能解码为 PCM → silk-wasm 编码
 *    支持: ogg, opus, aac, flac, wma, m4a, pcm 等所有 ffmpeg 支持的格式
 * 3. 无 ffmpeg → WASM fallback（仅支持 pcm, wav）
 *
 * @param directUploadFormats - 自定义直传格式列表，覆盖默认值。传 undefined 使用 QQ_NATIVE_UPLOAD_FORMATS
 */
export async function audioFileToSilkBase64(
  filePath: string,
  directUploadFormats?: string[],
): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    debugError(`[audio-convert] file is empty: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();

  // 0. 直传判断：QQ Bot API 原生支持 WAV/MP3/SILK，可通过配置覆盖
  const uploadFormats = directUploadFormats
    ? normalizeFormats(directUploadFormats)
    : QQ_NATIVE_UPLOAD_FORMATS;
  if (uploadFormats.includes(ext)) {
    debugLog(`[audio-convert] direct upload (QQ native format): ${ext} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  // 1. .slk / .amr 扩展名 → 检测 SILK 魔数，是 SILK 则直传
  if ([".slk", ".slac"].includes(ext)) {
    const stripped = stripAmrHeader(buf);
    const raw = new Uint8Array(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    if (isSilk(raw)) {
      debugLog(`[audio-convert] SILK file, direct use: ${filePath} (${buf.length} bytes)`);
      return buf.toString("base64");
    }
  }

  // 按文件头检测 SILK（不依赖扩展名）
  const rawCheck = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const strippedCheck = stripAmrHeader(buf);
  const strippedRaw = new Uint8Array(
    strippedCheck.buffer,
    strippedCheck.byteOffset,
    strippedCheck.byteLength,
  );
  if (isSilk(rawCheck) || isSilk(strippedRaw)) {
    debugLog(`[audio-convert] SILK detected by header: ${filePath} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  const targetRate = 24000;

  // 2. 优先使用 ffmpeg（业界标准做法，跨平台检测）
  const ffmpegCmd = await checkFfmpeg();
  if (ffmpegCmd) {
    try {
      debugLog(
        `[audio-convert] ffmpeg (${ffmpegCmd}): converting ${ext} (${buf.length} bytes) → PCM s16le ${targetRate}Hz`,
      );
      const pcmBuf = await ffmpegToPCM(ffmpegCmd, filePath, targetRate);
      if (pcmBuf.length === 0) {
        debugError(`[audio-convert] ffmpeg produced empty PCM output`);
        return null;
      }
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      debugLog(`[audio-convert] ffmpeg: ${ext} → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    } catch (err) {
      debugError(
        `[audio-convert] ffmpeg conversion failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // ffmpeg 失败后不 return，继续尝试 WASM fallback
    }
  }

  // 3. WASM fallback（无 ffmpeg 时的降级方案）
  debugLog(`[audio-convert] fallback: trying WASM decoders for ${ext}`);

  // 3a. PCM：视为 s16le 24000Hz 单声道
  if (ext === ".pcm") {
    const pcmBuf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
    return silkBuffer.toString("base64");
  }

  // 3b. WAV：手动解析（仅支持标准 PCM WAV）
  if (ext === ".wav" || (buf.length >= 4 && buf.toString("ascii", 0, 4) === "RIFF")) {
    const wavInfo = parseWavFallback(buf);
    if (wavInfo) {
      const { silkBuffer } = await pcmToSilk(wavInfo, targetRate);
      return silkBuffer.toString("base64");
    }
  }

  // 3c. MP3：WASM 解码
  if (ext === ".mp3" || ext === ".mpeg") {
    const pcmBuf = await wasmDecodeMp3ToPCM(buf, targetRate);
    if (pcmBuf) {
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      debugLog(`[audio-convert] WASM: MP3 → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    }
  }

  const installHint = isWindows()
    ? "安装方式: choco install ffmpeg 或 scoop install ffmpeg 或从 https://ffmpeg.org 下载"
    : process.platform === "darwin"
      ? "安装方式: brew install ffmpeg"
      : "安装方式: sudo apt install ffmpeg 或 sudo yum install ffmpeg";
  debugError(`[audio-convert] unsupported format: ${ext} (no ffmpeg available). ${installHint}`);
  return null;
}

/**
 * 等待文件就绪（轮询直到文件出现且大小稳定）
 * 用于 TTS 生成后等待文件写入完成
 *
 * 优化策略：
 * - 文件出现后如果持续 0 字节超过 emptyGiveUpMs（默认 10s），快速失败
 * - 文件未出现超过 noFileGiveUpMs（默认 15s），快速失败
 * - 整体超时 timeoutMs 作为最终兜底
 *
 * @param filePath 文件路径
 * @param timeoutMs 最大等待时间（默认 30 秒）
 * @param pollMs 轮询间隔（默认 500ms）
 * @returns 文件大小（字节），超时或文件始终为空返回 0
 */
export async function waitForFile(
  filePath: string,
  timeoutMs: number = 30000,
  pollMs: number = 500,
): Promise<number> {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  let fileExists = false;
  let fileAppearedAt = 0; // 文件首次出现时间
  let pollCount = 0;

  // 0 字节文件放弃等待阈值：文件出现后持续空文件超过此时间则快速失败
  const emptyGiveUpMs = 10000;
  // 文件始终不出现的放弃阈值
  const noFileGiveUpMs = 15000;

  while (Date.now() - start < timeoutMs) {
    pollCount++;
    try {
      const stat = fs.statSync(filePath);
      if (!fileExists) {
        fileExists = true;
        fileAppearedAt = Date.now();
        debugLog(
          `[audio-convert] waitForFile: file appeared (${stat.size} bytes, after ${Date.now() - start}ms): ${path.basename(filePath)}`,
        );
      }
      if (stat.size > 0) {
        if (stat.size === lastSize) {
          stableCount++;
          if (stableCount >= 2) {
            debugLog(
              `[audio-convert] waitForFile: ready (${stat.size} bytes, waited ${Date.now() - start}ms, polls=${pollCount})`,
            );
            return stat.size;
          }
        } else {
          stableCount = 0;
        }
        lastSize = stat.size;
      } else {
        // 文件存在但 0 字节：检查是否已超过空文件等待阈值
        if (Date.now() - fileAppearedAt > emptyGiveUpMs) {
          debugError(
            `[audio-convert] waitForFile: file still empty after ${emptyGiveUpMs}ms, giving up: ${path.basename(filePath)}`,
          );
          return 0;
        }
      }
    } catch {
      // 文件不存在：检查是否已超过无文件等待阈值
      if (!fileExists && Date.now() - start > noFileGiveUpMs) {
        debugError(
          `[audio-convert] waitForFile: file never appeared after ${noFileGiveUpMs}ms, giving up: ${path.basename(filePath)}`,
        );
        return 0;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // 超时后最后检查一次
  try {
    const finalStat = fs.statSync(filePath);
    if (finalStat.size > 0) {
      debugWarn(
        `[audio-convert] waitForFile: timeout but file has data (${finalStat.size} bytes), using it`,
      );
      return finalStat.size;
    }
    debugError(
      `[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file exists but empty (0 bytes): ${path.basename(filePath)}`,
    );
  } catch {
    debugError(
      `[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file never appeared: ${path.basename(filePath)}`,
    );
  }
  return 0;
}

// ============ ffmpeg 跨平台调用 ============

/**
 * 检测 ffmpeg 是否可用（委托给 platform.ts 跨平台检测）
 * @returns ffmpeg 可执行路径或 null
 */
async function checkFfmpeg(): Promise<string | null> {
  return detectFfmpeg();
}

/**
 * 使用 ffmpeg 将任意音频文件转换为 PCM s16le 单声道 24kHz
 *
 * 跨平台注意:
 * - Windows 上 pipe:1 需要 encoding: "buffer" 防止 BOM 问题
 * - 使用 detectFfmpeg() 返回的完整路径，兼容非 PATH 安装
 */
function ffmpegToPCM(
  ffmpegCmd: string,
  inputPath: string,
  sampleRate: number = 24000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i",
      inputPath,
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-acodec",
      "pcm_s16le",
      "-v",
      "error",
      "pipe:1",
    ];
    execFile(
      ffmpegCmd,
      args,
      {
        maxBuffer: 50 * 1024 * 1024,
        encoding: "buffer",
        // Windows: 隐藏弹出的 cmd 窗口
        ...(isWindows() ? { windowsHide: true } : {}),
      },
      (err, stdout) => {
        if (err) {
          reject(new Error(`ffmpeg failed: ${err.message}`));
          return;
        }
        resolve(stdout as unknown as Buffer);
      },
    );
  });
}

// ============ WASM fallback: MP3 解码 ============

/**
 * 使用 mpg123-decoder (WASM) 解码 MP3 为 PCM
 * 仅在 ffmpeg 不可用时作为 fallback
 */
async function wasmDecodeMp3ToPCM(buf: Buffer, targetRate: number): Promise<Buffer | null> {
  try {
    const { MPEGDecoder } = await import("mpg123-decoder");
    debugLog(`[audio-convert] WASM MP3 decode: size=${buf.length} bytes`);
    const decoder = new MPEGDecoder();
    await decoder.ready;

    const decoded = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    decoder.free();

    if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
      debugError(
        `[audio-convert] WASM MP3 decode: no samples (samplesDecoded=${decoded.samplesDecoded})`,
      );
      return null;
    }

    debugLog(
      `[audio-convert] WASM MP3 decode: samples=${decoded.samplesDecoded}, sampleRate=${decoded.sampleRate}, channels=${decoded.channelData.length}`,
    );

    // Float32 多声道混缩为单声道
    let floatMono: Float32Array;
    if (decoded.channelData.length === 1) {
      floatMono = decoded.channelData[0];
    } else {
      floatMono = new Float32Array(decoded.samplesDecoded);
      const channels = decoded.channelData.length;
      for (let i = 0; i < decoded.samplesDecoded; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += decoded.channelData[ch][i];
        }
        floatMono[i] = sum / channels;
      }
    }

    // Float32 → s16le
    const s16 = new Uint8Array(floatMono.length * 2);
    const view = new DataView(s16.buffer);
    for (let i = 0; i < floatMono.length; i++) {
      const clamped = Math.max(-1, Math.min(1, floatMono[i]));
      const val = clamped < 0 ? clamped * 32768 : clamped * 32767;
      view.setInt16(i * 2, Math.round(val), true);
    }

    // 简单线性插值重采样
    let pcm: Uint8Array = s16;
    if (decoded.sampleRate !== targetRate) {
      const inputSamples = s16.length / 2;
      const outputSamples = Math.round((inputSamples * targetRate) / decoded.sampleRate);
      const output = new Uint8Array(outputSamples * 2);
      const inView = new DataView(s16.buffer, s16.byteOffset, s16.byteLength);
      const outView = new DataView(output.buffer, output.byteOffset, output.byteLength);
      for (let i = 0; i < outputSamples; i++) {
        const srcIdx = (i * decoded.sampleRate) / targetRate;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, inputSamples - 1);
        const frac = srcIdx - idx0;
        const s0 = inView.getInt16(idx0 * 2, true);
        const s1 = inView.getInt16(idx1 * 2, true);
        const sample = Math.round(s0 + (s1 - s0) * frac);
        outView.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
      }
      pcm = output;
    }

    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  } catch (err) {
    debugError(
      `[audio-convert] WASM MP3 decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      debugError(`[audio-convert] stack: ${err.stack}`);
    }
    return null;
  }
}

/**
 * 规范化格式列表（确保以 . 开头，小写）
 */
function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = f.toLowerCase().trim();
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
}

/**
 * WAV fallback 解析（无 ffmpeg 时使用）
 * 仅支持标准 PCM WAV (format=1, 16bit)
 */
function parseWavFallback(buf: Buffer): Buffer | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  if (buf.toString("ascii", 12, 16) !== "fmt ") return null;

  const audioFormat = buf.readUInt16LE(20);
  if (audioFormat !== 1) return null;

  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) return null;

  // 找 data chunk
  let offset = 36;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buf.length);
      let pcm = new Uint8Array(buf.buffer, buf.byteOffset + dataStart, dataEnd - dataStart);

      // 多声道混缩
      if (channels > 1) {
        const samplesPerCh = pcm.length / (2 * channels);
        const mono = new Uint8Array(samplesPerCh * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
        for (let i = 0; i < samplesPerCh; i++) {
          let sum = 0;
          for (let ch = 0; ch < channels; ch++) sum += inV.getInt16((i * channels + ch) * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
        }
        pcm = mono;
      }

      // 简单线性插值重采样
      const targetRate = 24000;
      if (sampleRate !== targetRate) {
        const inSamples = pcm.length / 2;
        const outSamples = Math.round((inSamples * targetRate) / sampleRate);
        const out = new Uint8Array(outSamples * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(out.buffer, out.byteOffset, out.byteLength);
        for (let i = 0; i < outSamples; i++) {
          const src = (i * sampleRate) / targetRate;
          const i0 = Math.floor(src);
          const i1 = Math.min(i0 + 1, inSamples - 1);
          const f = src - i0;
          const s0 = inV.getInt16(i0 * 2, true);
          const s1 = inV.getInt16(i1 * 2, true);
          outV.setInt16(
            i * 2,
            Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))),
            true,
          );
        }
        pcm = out;
      }

      return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    offset += 8 + chunkSize;
  }

  return null;
}
