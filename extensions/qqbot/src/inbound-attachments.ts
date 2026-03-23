/**
 * 入站附件处理模块
 *
 * 负责下载、转换、转录用户发送的附件（图片/语音/文件），
 * 并归类为统一的 ProcessedAttachments 结构供 gateway 消费。
 */

import { transcribeAudio, resolveSTTConfig } from "./stt.js";
import { convertSilkToWav, isVoiceAttachment, formatDuration } from "./utils/audio-convert.js";
import { downloadFile } from "./utils/file-utils.js";
import { getQQBotMediaDir } from "./utils/platform.js";

// ============ 类型定义 ============

export interface RawAttachment {
  content_type: string;
  url: string;
  filename?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export type TranscriptSource = "stt" | "asr" | "fallback";

/** processAttachments 的返回值 */
export interface ProcessedAttachments {
  /** 附件描述文本（其它类型附件） */
  attachmentInfo: string;
  /** 图片本地路径或远程 URL */
  imageUrls: string[];
  /** 图片 MIME 类型（与 imageUrls 一一对应） */
  imageMediaTypes: string[];
  /** 语音本地路径 */
  voiceAttachmentPaths: string[];
  /** 语音远程 URL */
  voiceAttachmentUrls: string[];
  /** QQ ASR 原始识别文本 */
  voiceAsrReferTexts: string[];
  /** 语音转录文本 */
  voiceTranscripts: string[];
  /** 转录来源 */
  voiceTranscriptSources: TranscriptSource[];
  /** 每个附件的本地路径（与原始 attachments 数组一一对应，未下载的为 null） */
  attachmentLocalPaths: Array<string | null>;
}

interface ProcessContext {
  accountId: string;
  cfg: unknown;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// ============ 空结果常量 ============

const EMPTY_RESULT: ProcessedAttachments = {
  attachmentInfo: "",
  imageUrls: [],
  imageMediaTypes: [],
  voiceAttachmentPaths: [],
  voiceAttachmentUrls: [],
  voiceAsrReferTexts: [],
  voiceTranscripts: [],
  voiceTranscriptSources: [],
  attachmentLocalPaths: [],
};

// ============ 主函数 ============

/**
 * 处理入站消息的附件列表。
 *
 * 三阶段流水线：
 * 1. 并行下载所有附件到本地
 * 2. 并行处理语音转换 + STT 转录
 * 3. 按原始顺序归类结果
 */
export async function processAttachments(
  attachments: RawAttachment[] | undefined,
  ctx: ProcessContext,
): Promise<ProcessedAttachments> {
  if (!attachments?.length) return EMPTY_RESULT;

  const { accountId, cfg, log } = ctx;
  const downloadDir = getQQBotMediaDir("downloads");
  const prefix = `[qqbot:${accountId}]`;

  // 结果收集
  const imageUrls: string[] = [];
  const imageMediaTypes: string[] = [];
  const voiceAttachmentPaths: string[] = [];
  const voiceAttachmentUrls: string[] = [];
  const voiceAsrReferTexts: string[] = [];
  const voiceTranscripts: string[] = [];
  const voiceTranscriptSources: TranscriptSource[] = [];
  const attachmentLocalPaths: Array<string | null> = [];
  const otherAttachments: string[] = [];

  // Phase 1: 并行下载所有附件
  const downloadTasks = attachments.map(async (att) => {
    const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;
    const isVoice = isVoiceAttachment(att);
    const wavUrl =
      isVoice && att.voice_wav_url
        ? att.voice_wav_url.startsWith("//")
          ? `https:${att.voice_wav_url}`
          : att.voice_wav_url
        : "";

    let localPath: string | null = null;
    let audioPath: string | null = null;

    if (isVoice && wavUrl) {
      const wavLocalPath = await downloadFile(wavUrl, downloadDir);
      if (wavLocalPath) {
        localPath = wavLocalPath;
        audioPath = wavLocalPath;
        log?.info(
          `${prefix} Voice attachment: ${att.filename}, downloaded WAV directly (skip SILK→WAV)`,
        );
      } else {
        log?.error(`${prefix} Failed to download voice_wav_url, falling back to original URL`);
      }
    }

    if (!localPath) {
      localPath = await downloadFile(attUrl, downloadDir, att.filename);
    }

    return { att, attUrl, isVoice, localPath, audioPath };
  });

  const downloadResults = await Promise.all(downloadTasks);

  // Phase 2: 并行处理语音转换 + 转录（非语音附件同步归类）
  const processTasks = downloadResults.map(
    async ({ att, attUrl, isVoice, localPath, audioPath }) => {
      const asrReferText = typeof att.asr_refer_text === "string" ? att.asr_refer_text.trim() : "";
      const wavUrl =
        isVoice && att.voice_wav_url
          ? att.voice_wav_url.startsWith("//")
            ? `https:${att.voice_wav_url}`
            : att.voice_wav_url
          : "";
      const voiceSourceUrl = wavUrl || attUrl;

      const meta = {
        voiceUrl: isVoice && voiceSourceUrl ? voiceSourceUrl : undefined,
        asrReferText: isVoice && asrReferText ? asrReferText : undefined,
      };

      if (localPath) {
        if (att.content_type?.startsWith("image/")) {
          log?.info(`${prefix} Downloaded attachment to: ${localPath}`);
          return { localPath, type: "image" as const, contentType: att.content_type, meta };
        } else if (isVoice) {
          log?.info(`${prefix} Downloaded attachment to: ${localPath}`);
          return processVoiceAttachment(
            localPath,
            audioPath,
            att,
            asrReferText,
            cfg,
            downloadDir,
            log,
            prefix,
          );
        } else {
          log?.info(`${prefix} Downloaded attachment to: ${localPath}`);
          return { localPath, type: "other" as const, filename: att.filename, meta };
        }
      } else {
        log?.error(`${prefix} Failed to download: ${attUrl}`);
        if (att.content_type?.startsWith("image/")) {
          return {
            localPath: null,
            type: "image-fallback" as const,
            attUrl,
            contentType: att.content_type,
            meta,
          };
        } else if (isVoice && asrReferText) {
          log?.info(`${prefix} Voice attachment download failed, using asr_refer_text fallback`);
          return {
            localPath: null,
            type: "voice-fallback" as const,
            transcript: asrReferText,
            meta,
          };
        } else {
          return {
            localPath: null,
            type: "other-fallback" as const,
            filename: att.filename ?? att.content_type,
            meta,
          };
        }
      }
    },
  );

  const processResults = await Promise.all(processTasks);

  // Phase 3: 按原始顺序归类结果
  for (const result of processResults) {
    if (result.meta.voiceUrl) voiceAttachmentUrls.push(result.meta.voiceUrl);
    if (result.meta.asrReferText) voiceAsrReferTexts.push(result.meta.asrReferText);

    if (result.type === "image" && result.localPath) {
      imageUrls.push(result.localPath);
      imageMediaTypes.push(result.contentType);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "voice" && result.localPath) {
      voiceAttachmentPaths.push(result.localPath);
      voiceTranscripts.push(result.transcript);
      voiceTranscriptSources.push(result.transcriptSource);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "other" && result.localPath) {
      otherAttachments.push(`[附件: ${result.localPath}]`);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "image-fallback") {
      imageUrls.push(result.attUrl);
      imageMediaTypes.push(result.contentType);
      attachmentLocalPaths.push(null);
    } else if (result.type === "voice-fallback") {
      voiceTranscripts.push(result.transcript);
      voiceTranscriptSources.push("asr");
      attachmentLocalPaths.push(null);
    } else if (result.type === "other-fallback") {
      otherAttachments.push(`[附件: ${result.filename}] (下载失败)`);
      attachmentLocalPaths.push(null);
    }
  }

  const attachmentInfo = otherAttachments.length > 0 ? "\n" + otherAttachments.join("\n") : "";

  return {
    attachmentInfo,
    imageUrls,
    imageMediaTypes,
    voiceAttachmentPaths,
    voiceAttachmentUrls,
    voiceAsrReferTexts,
    voiceTranscripts,
    voiceTranscriptSources,
    attachmentLocalPaths,
  };
}

/**
 * 将语音转录结果组装为用户消息中的文本片段。
 */
export function formatVoiceText(transcripts: string[]): string {
  if (transcripts.length === 0) return "";
  return transcripts.length === 1
    ? `[语音消息] ${transcripts[0]}`
    : transcripts.map((t, i) => `[语音${i + 1}] ${t}`).join("\n");
}

// ============ 内部辅助 ============

type VoiceResult =
  | {
      localPath: string;
      type: "voice";
      transcript: string;
      transcriptSource: TranscriptSource;
      meta: { voiceUrl?: string; asrReferText?: string };
    }
  | {
      localPath: string;
      type: "voice";
      transcript: string;
      transcriptSource: TranscriptSource;
      meta: { voiceUrl?: string; asrReferText?: string };
    };

async function processVoiceAttachment(
  localPath: string,
  audioPath: string | null,
  att: RawAttachment,
  asrReferText: string,
  cfg: unknown,
  downloadDir: string,
  log: ProcessContext["log"],
  prefix: string,
): Promise<VoiceResult> {
  const wavUrl = att.voice_wav_url
    ? att.voice_wav_url.startsWith("//")
      ? `https:${att.voice_wav_url}`
      : att.voice_wav_url
    : "";
  const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;
  const voiceSourceUrl = wavUrl || attUrl;
  const meta = {
    voiceUrl: voiceSourceUrl || undefined,
    asrReferText: asrReferText || undefined,
  };

  const sttCfg = resolveSTTConfig(cfg as Record<string, unknown>);
  if (!sttCfg) {
    if (asrReferText) {
      log?.info(
        `${prefix} Voice attachment: ${att.filename} (STT not configured, using asr_refer_text fallback)`,
      );
      return { localPath, type: "voice", transcript: asrReferText, transcriptSource: "asr", meta };
    }
    log?.info(
      `${prefix} Voice attachment: ${att.filename} (STT not configured, skipping transcription)`,
    );
    return {
      localPath,
      type: "voice",
      transcript: "[语音消息 - 语音识别未配置，无法转录]",
      transcriptSource: "fallback",
      meta,
    };
  }

  // SILK→WAV 转换
  if (!audioPath) {
    log?.info(`${prefix} Voice attachment: ${att.filename}, converting SILK→WAV...`);
    try {
      const wavResult = await convertSilkToWav(localPath, downloadDir);
      if (wavResult) {
        audioPath = wavResult.wavPath;
        log?.info(
          `${prefix} Voice converted: ${wavResult.wavPath} (${formatDuration(wavResult.duration)})`,
        );
      } else {
        audioPath = localPath;
      }
    } catch (convertErr) {
      log?.error(`${prefix} Voice conversion failed: ${convertErr}`);
      if (asrReferText) {
        return {
          localPath,
          type: "voice",
          transcript: asrReferText,
          transcriptSource: "asr",
          meta,
        };
      }
      return {
        localPath,
        type: "voice",
        transcript: "[语音消息 - 格式转换失败]",
        transcriptSource: "fallback",
        meta,
      };
    }
  }

  // STT 转录
  try {
    const transcript = await transcribeAudio(audioPath!, cfg as Record<string, unknown>);
    if (transcript) {
      log?.info(`${prefix} STT transcript: ${transcript.slice(0, 100)}...`);
      return { localPath, type: "voice", transcript, transcriptSource: "stt", meta };
    }
    if (asrReferText) {
      log?.info(`${prefix} STT returned empty result, using asr_refer_text fallback`);
      return { localPath, type: "voice", transcript: asrReferText, transcriptSource: "asr", meta };
    }
    log?.info(`${prefix} STT returned empty result`);
    return {
      localPath,
      type: "voice",
      transcript: "[语音消息 - 转录结果为空]",
      transcriptSource: "fallback",
      meta,
    };
  } catch (sttErr) {
    log?.error(`${prefix} STT failed: ${sttErr}`);
    if (asrReferText) {
      return { localPath, type: "voice", transcript: asrReferText, transcriptSource: "asr", meta };
    }
    return {
      localPath,
      type: "voice",
      transcript: "[语音消息 - 转录失败]",
      transcriptSource: "fallback",
      meta,
    };
  }
}
