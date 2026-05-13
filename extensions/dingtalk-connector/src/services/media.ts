/**
 * 钉钉媒体处理
 * 支持图片、视频、音频、文件的上传和下载
 */

import * as fs from 'fs';
import * as path from 'path';
// form-data 是 CJS 模块，静态 import 可确保 jiti/ESM 环境下 CJS 互操作行为稳定，
// 避免动态 import 时 .default 偶发为 undefined 导致 "Cannot read properties of undefined (reading 'registry')"
import FormData from 'form-data';
import type { DingtalkConfig } from '../types/index.ts';
import { DINGTALK_OAPI, getOapiAccessToken } from '../utils/index.ts';
import { dingtalkHttp, dingtalkOapiHttp } from '../utils/http-client.ts';


/** 文本文件扩展名 */
export const TEXT_FILE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.py',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sh',
  '.bat',
  '.csv',
]);

/** 图片文件扩展名 */
export const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|bmp|webp|tiff|svg)$/i;

/** 本地图片路径正则表达式（跨平台） */
export const LOCAL_IMAGE_RE =
  /!\[([^\]]*)\]\(((?:file:\/\/\/|MEDIA:|attachment:\/\/\/)[^)]+|\/(?:tmp|var|private|Users|home|root)[^)]+|[A-Za-z]:[\\/][^)]+)\)/g;

/** 纯文本图片路径正则表达式 */
export const BARE_IMAGE_PATH_RE =
  /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))`?/gi;

/** 视频标记正则表达式 */
export const VIDEO_MARKER_PATTERN = /\[DINGTALK_VIDEO\](.*?)\[\/DINGTALK_VIDEO\]/gs;

/** 音频标记正则表达式 */
export const AUDIO_MARKER_PATTERN = /\[DINGTALK_AUDIO\](.*?)\[\/DINGTALK_AUDIO\]/gs;

/** 文件标记正则表达式 */
export const FILE_MARKER_PATTERN = /\[DINGTALK_FILE\](.*?)\[\/DINGTALK_FILE\]/gs;


/**
 * 去掉 file:// / MEDIA: / attachment:// 前缀，得到实际的绝对路径
 */
export function toLocalPath(raw: string): string {
  let filePath = raw;
  if (filePath.startsWith('file://')) filePath = filePath.replace('file://', '');
  else if (filePath.startsWith('MEDIA:')) filePath = filePath.replace('MEDIA:', '');
  else if (filePath.startsWith('attachment://')) filePath = filePath.replace('attachment://', '');

  // 解码 URL 编码的路径（如中文字符 %E5%9B%BE → 图）
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // 解码失败则保持原样
  }
  return filePath;
}

/**
 * 通用媒体文件上传函数
 */
/** 上传结果接口 */
export interface UploadResult {
  mediaId: string;      // 原始 media_id（带 @）
  cleanMediaId: string; // 去掉 @ 的 media_id
  downloadUrl: string;  // 下载链接
}

export async function uploadMediaToDingTalk(
  filePath: string,
  mediaType: 'image' | 'file' | 'video' | 'voice',
  oapiToken: string,
  maxSize: number = 20 * 1024 * 1024,
  log?: any,
): Promise<UploadResult | null> {
  try {
    const absPath = toLocalPath(filePath);
    log?.info?.(`开始上传，文件路径：${absPath}`);
    
    if (!fs.existsSync(absPath)) {
      log?.warn?.(`文件不存在：${absPath}`);
      return null;
    }

    // 检查文件大小
    const stats = fs.statSync(absPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSize = stats.size;

    log?.info?.(`文件大小：${fileSizeMB}MB`);

    // 检查文件大小是否超过限制
    if (stats.size > maxSize) {
      const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(0);
      log?.warn?.(
        `文件过大：${absPath}, 大小：${fileSizeMB}MB, 超过限制 ${maxSizeMB}MB`,
      );
      return null;
    }

    // ✅ 根据媒体类型设置正确的 contentType
    const getContentType = () => {
      const ext = path.extname(absPath).toLowerCase();
      if (mediaType === 'image') {
        return ext === '.png' ? 'image/png' : 'image/jpeg';
      } else if (mediaType === 'video') {
        return ext === '.mp4' ? 'video/mp4' : 'video/quicktime';
      } else if (mediaType === 'voice') {
        return ext === '.mp3' ? 'audio/mpeg' : 'audio/amr';
      } else {
        return 'application/octet-stream';
      }
    };

    const form = new FormData();
    form.append('media', fs.createReadStream(absPath), {
      filename: path.basename(absPath),
      contentType: getContentType(),
    });

    log?.info?.(`上传文件: ${absPath} (${fileSizeMB}MB)`);
    const resp = await dingtalkOapiHttp.post(
      `${DINGTALK_OAPI}/media/upload?access_token=${oapiToken}&type=${mediaType === 'video' ? 'file' : mediaType}`,
      form,
      { headers: form.getHeaders(), timeout: 60_000 },
    );

    const mediaId = resp.data?.media_id;
    if (mediaId) {
      // ✅ 去掉 media_id 前面的 @ 符号（如果有的话）
      const cleanMediaId = mediaId.startsWith('@') ? mediaId.substring(1) : mediaId;
      // ✅ 将 media_id 转换为钉钉下载链接
      const downloadUrl = `https://down.dingtalk.com/media/${cleanMediaId}`;
      log?.info?.(`上传成功: media_id=${mediaId}, cleanMediaId=${cleanMediaId}, downloadUrl=${downloadUrl}`);
      return {
        mediaId,
        cleanMediaId,
        downloadUrl,
      };
    }
    log?.warn?.(`上传返回无 media_id: ${JSON.stringify(resp.data)}`);
    return null;
  } catch (err: any) {
    log?.error?.(`上传失败: ${err.message}`);
    return null;
  }
}

/**
 * 扫描内容中的本地图片路径，上传到钉钉并替换为 media_id
 */
export async function processLocalImages(
  content: string,
  oapiToken: string | null,
  log?: any,
): Promise<string> {
  if (!oapiToken) {
    log?.warn?.(`无 oapiToken，跳过图片后处理`);
    return content;
  }

  let result = content;

  // 第一步：匹配 markdown 图片语法 ![alt](path)
  const mdMatches = [...content.matchAll(LOCAL_IMAGE_RE)];
  if (mdMatches.length > 0) {
    log?.info?.(`检测到 ${mdMatches.length} 个 markdown 图片，开始上传...`);
    for (const match of mdMatches) {
      const [fullMatch, alt, rawPath] = match;
      // 清理转义字符（AI 可能会对含空格的路径添加 \ ）
      const cleanPath = rawPath.replace(/\\ /g, ' ');
      const uploadResult = await uploadMediaToDingTalk(cleanPath, 'image', oapiToken, 20 * 1024 * 1024, log);
      if (uploadResult) {
        result = result.replace(fullMatch, `![${alt}](${uploadResult.downloadUrl})`);
      }
    }
  }

  // 第二步：匹配纯文本中的本地图片路径
  const bareMatches = [...result.matchAll(BARE_IMAGE_PATH_RE)];
  const newBareMatches = bareMatches.filter((m) => {
    // 检查这个路径是否已经在 ![...](...) 中
    if (m.index === undefined) return false;
    const idx = m.index;
    const before = result.slice(Math.max(0, idx - 10), idx);
    return !before.includes('](');
  });

  if (newBareMatches.length > 0) {
    log?.info?.(`检测到 ${newBareMatches.length} 个纯文本图片路径，开始上传...`);
    // 从后往前替换，避免 index 偏移
    for (const match of newBareMatches.reverse()) {
      const [fullMatch, rawPath] = match;
      log?.info?.(`纯文本图片: "${fullMatch}" -> path="${rawPath}"`);
      const uploadResult = await uploadMediaToDingTalk(rawPath, 'image', oapiToken, 20 * 1024 * 1024, log);
      if (uploadResult) {
        const replacement = `![](${uploadResult.downloadUrl})`;
        result = result.slice(0, match.index!) + result.slice(match.index!).replace(fullMatch, replacement);
        log?.info?.(`替换纯文本路径为图片: ${replacement}`);
      }
    }
  }

  return result;
}


/** 视频信息接口 */
export interface VideoInfo {
  path: string;
}

/**
 * 提取视频元数据（时长、分辨率）
 */
export async function extractVideoMetadata(
  filePath: string,
  log?: any,
): Promise<{ duration: number; width: number; height: number } | null> {
  try {
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const ffprobePath = require('@ffprobe-installer/ffprobe').path;
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
        if (err) {
          log?.warn?.(`ffprobe 执行失败: ${err.message}`);
          resolve(null);
          return;
        }
        try {
          // ✅ 钉钉 API 需要毫秒，ffprobe 返回的是秒，需要转换
          const duration = metadata.format?.duration ? Math.round(parseFloat(metadata.format.duration) * 1000) : 0;
          const videoStream = metadata.streams?.find((s: any) => s.codec_type === 'video');
          const width = videoStream?.width || 0;
          const height = videoStream?.height || 0;
          resolve({ duration, width, height });
        } catch (err) {
          log?.warn?.(`解析 ffprobe 输出失败`);
          resolve(null);
        }
      });
    });
  } catch (err: any) {
    log?.warn?.(`提取视频元数据失败: ${err.message}`);
    return null;
  }
}

/**
 * 生成视频封面图（第1秒截图）
 */
export async function extractVideoThumbnail(
  videoPath: string,
  outputPath: string,
  log?: any,
): Promise<string | null> {
  try {
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const path = await import('path');
    ffmpeg.setFfmpegPath(ffmpegPath);

    return new Promise((resolve) => {
      ffmpeg(videoPath)
        .screenshots({
          count: 1,
          folder: path.dirname(outputPath),
          filename: path.basename(outputPath),
          timemarks: ['1'],
          size: '?x360',
        })
        .on('end', () => {
          log?.info?.(`封面生成成功: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err: any) => {
          log?.error?.(`封面生成失败: ${err.message}`);
          resolve(null);
        });
    });
  } catch (err: any) {
    log?.error?.(`ffmpeg 失败: ${err.message}`);
    return null;
  }
}

/**
 * 提取视频标记并发送视频消息
 */
export async function processVideoMarkers(
  content: string,
  sessionWebhook: string,
  config: DingtalkConfig,
  oapiToken: string | null,
  log?: any,
  useProactiveApi: boolean = false,
  target?: any,
): Promise<string> {
  const logPrefix = useProactiveApi ? 'Video[Proactive]' : 'Video';

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过视频处理`);
    return content;
  }

  const matches = [...content.matchAll(VIDEO_MARKER_PATTERN)];
  const videoInfos: VideoInfo[] = [];
  const invalidVideos: string[] = [];
  
  // 导入需要的模块
  const os = await import('os');

  for (const match of matches) {
    try {
      const videoInfo = JSON.parse(match[1]) as VideoInfo;
      if (videoInfo.path && fs.existsSync(videoInfo.path)) {
        videoInfos.push(videoInfo);
        log?.info?.(`${logPrefix} 提取到视频: ${videoInfo.path}`);
      } else {
        invalidVideos.push(videoInfo.path || '未知路径');
        log?.warn?.(`${logPrefix} 视频文件不存在: ${videoInfo.path}`);
      }
    } catch (err: any) {
      log?.warn?.(`${logPrefix} 解析标记失败: ${err.message}`);
    }
  }

  if (videoInfos.length === 0 && invalidVideos.length === 0) {
    log?.info?.(`${logPrefix} 未检测到视频标记`);
    return content.replace(VIDEO_MARKER_PATTERN, '').trim();
  }

  // 先移除所有视频标记
  let cleanedContent = content.replace(VIDEO_MARKER_PATTERN, '').trim();

  const statusMessages: string[] = [];

  for (const invalidPath of invalidVideos) {
    statusMessages.push(`⚠️ 视频文件不存在: ${path.basename(invalidPath)}`);
  }

  if (videoInfos.length > 0) {
    log?.info?.(`${logPrefix} 检测到 ${videoInfos.length} 个视频，开始处理...`);
  }

  for (const videoInfo of videoInfos) {
    const fileName = path.basename(videoInfo.path);
    let thumbnailPath = '';
    try {
      // 1. 提取视频元数据
      const metadata = await extractVideoMetadata(videoInfo.path, log);
      if (!metadata) {
        log?.warn?.(`${logPrefix} 无法提取元数据: ${videoInfo.path}`);
        statusMessages.push(`⚠️ 视频处理失败: ${fileName}（无法读取视频信息）`);
        continue;
      }

      // 2. 生成封面图
      thumbnailPath = path.join(os.tmpdir(), `thumbnail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`);
      log?.info?.(`${logPrefix} 准备生成封面: ${thumbnailPath}`);
      const thumbnail = await extractVideoThumbnail(videoInfo.path, thumbnailPath, log);
      if (!thumbnail) {
        log?.warn?.(`${logPrefix} 无法生成封面: ${videoInfo.path}`);
        statusMessages.push(`⚠️ 视频处理失败: ${fileName}（无法生成封面）`);
        continue;
      }
      
      // 检查生成的封面文件
      if (fs.existsSync(thumbnailPath)) {
        const stats = fs.statSync(thumbnailPath);
        log?.info?.(`${logPrefix} 封面文件生成完成: ${thumbnailPath}, 大小: ${(stats.size / 1024).toFixed(2)}KB`);
        if (stats.size < 1024) {  // 小于1KB可能有问题
          log?.warn?.(`${logPrefix} 封面文件过小，可能存在质量问题`);
        }
      } else {
        log?.error?.(`${logPrefix} 封面文件未生成: ${thumbnailPath}`);
        statusMessages.push(`⚠️ 视频处理失败: ${fileName}（封面文件未生成）`);
        continue;
      }

      // 3. 上传视频
      const videoUploadResult = await uploadMediaToDingTalk(videoInfo.path, 'video', oapiToken, 20 * 1024 * 1024, log);
      if (!videoUploadResult) {
        log?.warn?.(`${logPrefix} 视频上传失败: ${videoInfo.path}`);
        statusMessages.push(`⚠️ 视频上传失败: ${fileName}（文件可能超过 20MB 限制）`);
        continue;
      }
      const videoMediaId = videoUploadResult.mediaId; // 使用原始 media_id（带 @）

      // 4. 上传封面
      const picUploadResult = await uploadMediaToDingTalk(thumbnailPath, 'image', oapiToken, 20 * 1024 * 1024, log);
      if (!picUploadResult) {
        log?.warn?.(`${logPrefix} 封面上传失败: ${thumbnailPath}`);
        statusMessages.push(`⚠️ 视频封面上传失败: ${fileName}`);
        continue;
      }
      const picMediaId = picUploadResult.mediaId; // 使用原始 media_id（带 @）

      // 5. 发送视频消息
      if (useProactiveApi && target) {
        await sendVideoProactive(config, target, videoMediaId, picMediaId, metadata, log);
      } else {
        await sendVideoMessage(config, sessionWebhook, fileName, videoUploadResult.downloadUrl, log, metadata);
      }
      
      statusMessages.push(`✅ 视频已发送: ${fileName}`);
      log?.info?.(`${logPrefix} 视频处理完成: ${fileName}`);
    } catch (err: any) {
      log?.error?.(`${logPrefix} 处理视频失败: ${err.message}`);
      statusMessages.push(`⚠️ 视频处理异常: ${fileName}（${err.message}）`);
    } finally {
      // 清理临时封面文件
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        try {
          fs.unlinkSync(thumbnailPath);
          log?.info?.(`${logPrefix} 临时封面已清理: ${thumbnailPath}`);
        } catch (cleanupErr: any) {
          log?.warn?.(`${logPrefix} 清理临时文件失败: ${cleanupErr?.message || cleanupErr}`);
        }
      }
    }
  }

  if (statusMessages.length > 0) {
    const statusText = statusMessages.join('\n');
    cleanedContent = cleanedContent
      ? `${cleanedContent}\n\n${statusText}`
      : statusText;
  }

  return cleanedContent;
}


/** 音频信息接口 */
export interface AudioInfo {
  path: string;
}

/**
 * 提取音频时长
 *
 * 使用 fluent-ffmpeg 的 ffprobe API，与 extractVideoMetadata 保持一致，
 * 完全避免直接调用 child_process，消除安全扫描误报。
 */
async function extractAudioDuration(filePath: string, log?: any): Promise<number | null> {
  try {
    const ffmpeg = require('fluent-ffmpeg');

    // 优先使用 @ffprobe-installer/ffprobe 提供的固定路径
    try {
      const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
      if (ffprobeInstaller?.path) {
        ffmpeg.setFfprobePath(ffprobeInstaller.path);
      }
    } catch {
      // @ffprobe-installer/ffprobe 未安装（optionalDependency），使用系统 ffprobe
    }

    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
        if (err) {
          log?.warn?.(`ffprobe 执行失败: ${err.message}`);
          resolve(null);
          return;
        }
        try {
          const duration = metadata.format?.duration
            ? Math.round(parseFloat(metadata.format.duration) * 1000)
            : 0;
          resolve(duration);
        } catch (parseErr) {
          log?.warn?.(`解析 ffprobe 输出失败`);
          resolve(null);
        }
      });
    });
  } catch (err: any) {
    log?.warn?.(`提取音频时长失败: ${err.message}`);
    return null;
  }
}

/**
 * 提取音频标记并发送音频消息
 */
export async function processAudioMarkers(
  content: string,
  sessionWebhook: string,
  config: DingtalkConfig,
  oapiToken: string | null,
  log?: any,
  useProactiveApi: boolean = false,
  target?: any,
): Promise<string> {
  const logPrefix = useProactiveApi ? 'Audio[Proactive]' : 'Audio';

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过音频处理`);
    return content;
  }

  const matches = [...content.matchAll(AUDIO_MARKER_PATTERN)];
  const audioInfos: AudioInfo[] = [];
  const invalidAudios: string[] = [];

  for (const match of matches) {
    try {
      const audioInfo = JSON.parse(match[1]) as AudioInfo;
      if (audioInfo.path && fs.existsSync(audioInfo.path)) {
        audioInfos.push(audioInfo);
        log?.info?.(`${logPrefix} 提取到音频: ${audioInfo.path}`);
      } else {
        invalidAudios.push(audioInfo.path || '未知路径');
        log?.warn?.(`${logPrefix} 音频文件不存在: ${audioInfo.path}`);
      }
    } catch (err: any) {
      log?.warn?.(`${logPrefix} 解析标记失败: ${err.message}`);
    }
  }

  if (audioInfos.length === 0 && invalidAudios.length === 0) {
    log?.info?.(`${logPrefix} 未检测到音频标记`);
    return content.replace(AUDIO_MARKER_PATTERN, '').trim();
  }

  // 先移除所有音频标记
  let cleanedContent = content.replace(AUDIO_MARKER_PATTERN, '').trim();

  const statusMessages: string[] = [];

  for (const invalidPath of invalidAudios) {
    statusMessages.push(`⚠️ 音频文件不存在: ${path.basename(invalidPath)}`);
  }

  if (audioInfos.length > 0) {
    log?.info?.(`${logPrefix} 检测到 ${audioInfos.length} 个音频，开始处理...`);
  }

  for (const audioInfo of audioInfos) {
    const fileName = path.basename(audioInfo.path);
    try {
      const ext = path.extname(audioInfo.path).slice(1).toLowerCase();

      // 上传音频到钉钉
      const uploadResult = await uploadMediaToDingTalk(audioInfo.path, 'voice', oapiToken, 20 * 1024 * 1024, log);
      if (!uploadResult) {
        statusMessages.push(`⚠️ 音频上传失败: ${fileName}（文件可能超过 20MB 限制）`);
        continue;
      }

      // 提取音频实际时长
      const audioDurationMs = await extractAudioDuration(audioInfo.path, log);

      // 发送音频消息
      if (useProactiveApi && target) {
        await sendAudioProactive(config, target, fileName, uploadResult.downloadUrl, log, audioDurationMs ?? undefined);
      } else {
        await sendAudioMessage(config, sessionWebhook, fileName, uploadResult.downloadUrl, log, audioDurationMs ?? undefined);
      }
      statusMessages.push(`✅ 音频已发送: ${fileName}`);
      log?.info?.(`${logPrefix} 音频处理完成: ${fileName}`);
    } catch (err: any) {
      log?.error?.(`${logPrefix} 处理音频失败: ${err.message}`);
      statusMessages.push(`⚠️ 音频处理异常: ${fileName}（${err.message}）`);
    }
  }

  if (statusMessages.length > 0) {
    const statusText = statusMessages.join('\n');
    cleanedContent = cleanedContent
      ? `${cleanedContent}\n\n${statusText}`
      : statusText;
  }

  return cleanedContent;
}


/** 文件信息接口 */
export interface FileInfo {
  path: string;
  fileName: string;
  fileType: string;
}

/**
 * 提取文件标记，上传文件到钉钉，并发送独立的文件消息（webhook 或 proactive API）。
 * 
 * 注意：此函数既做「上传」也做「发送」，是完整版的文件处理流程。
 * 与 media/file.ts 中的 uploadAndReplaceFileMarkers 不同，后者只做上传+文本替换。
 * 
 * 调用方：messaging.ts（直接 import media.ts）
 */
export async function processFileMarkers(
  content: string,
  sessionWebhook: string,
  config: DingtalkConfig,
  oapiToken: string | null,
  log?: any,
  useProactiveApi: boolean = false,
  target?: any,
): Promise<string> {
  const logPrefix = useProactiveApi ? 'File[Proactive]' : 'File';

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过文件处理`);
    return content;
  }

  const matches = [...content.matchAll(FILE_MARKER_PATTERN)];
  const fileInfos: FileInfo[] = [];
  const invalidFiles: string[] = [];

  for (const match of matches) {
    try {
      const fileInfo = JSON.parse(match[1]) as FileInfo;
      if (fileInfo.path && fs.existsSync(fileInfo.path)) {
        fileInfos.push(fileInfo);
        log?.info?.(`${logPrefix} 提取到文件: ${fileInfo.path}`);
      } else {
        invalidFiles.push(fileInfo.path || '未知路径');
        log?.warn?.(`${logPrefix} 文件不存在: ${fileInfo.path}`);
      }
    } catch (err: any) {
      log?.warn?.(`${logPrefix} 解析标记失败: ${err.message}`);
    }
  }

  if (fileInfos.length === 0 && invalidFiles.length === 0) {
    log?.info?.(`${logPrefix} 未检测到文件标记`);
    return content.replace(FILE_MARKER_PATTERN, '').trim();
  }

  // 先移除所有文件标记
  let cleanedContent = content.replace(FILE_MARKER_PATTERN, '').trim();

  const statusMessages: string[] = [];

  for (const invalidPath of invalidFiles) {
    statusMessages.push(`⚠️ 文件不存在: ${path.basename(invalidPath)}`);
  }

  if (fileInfos.length > 0) {
    log?.info?.(`${logPrefix} 检测到 ${fileInfos.length} 个文件，开始处理...`);
  }

  for (const fileInfo of fileInfos) {
    const fileName = fileInfo.fileName || path.basename(fileInfo.path);
    try {
      // 上传文件到钉钉
      const uploadResult = await uploadMediaToDingTalk(fileInfo.path, 'file', oapiToken, 20 * 1024 * 1024, log);
      if (!uploadResult) {
        statusMessages.push(`⚠️ 文件上传失败: ${fileName}（文件可能超过 20MB 限制）`);
        continue;
      }

      // 发送文件消息（钉钉 API 统一要求带 @ 前缀的 mediaId）
      if (useProactiveApi && target) {
        await sendFileProactive(config, target, fileInfo, uploadResult.mediaId, log);
      } else {
        await sendFileMessage(config, sessionWebhook, fileInfo, uploadResult.mediaId, log);
      }
      statusMessages.push(`✅ 文件已发送: ${fileName}`);
      log?.info?.(`${logPrefix} 文件处理完成: ${fileName}`);
    } catch (err: any) {
      log?.error?.(`${logPrefix} 处理文件失败: ${err.message}`);
      statusMessages.push(`⚠️ 文件处理异常: ${fileName}（${err.message}）`);
    }
  }

  if (statusMessages.length > 0) {
    const statusText = statusMessages.join('\n');
    cleanedContent = cleanedContent
      ? `${cleanedContent}\n\n${statusText}`
      : statusText;
  }

  return cleanedContent;
}


/** 视频元数据接口 */
interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
}

/**
 * 发送视频消息（sessionWebhook 模式）
 */
async function sendVideoMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  fileName: string,
  mediaId: string,
  log?: any,
  metadata?: { duration: number; width: number; height: number },
): Promise<void> {
  try {
    const token = await (await import('../utils/index.ts')).getAccessToken(config);
    
    // 钉钉视频消息格式（sessionWebhook 模式）
    const videoMessage = {
      msgtype: 'video',
      video: {
        mediaId: mediaId,
        duration: metadata?.duration.toString() || '60000',
        type: 'mp4',
      },
    };

    log?.info?.(`发送视频消息: ${fileName}`);
    const resp = await dingtalkHttp.post(sessionWebhook, videoMessage, {
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });

    if (resp.data?.success !== false) {
      log?.info?.(`视频消息发送成功: ${fileName}`);
    } else {
      log?.error?.(`视频消息发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: any) {
    log?.error?.(`发送视频消息异常: ${fileName}, 错误: ${err.message}`);
  }
}

/**
 * 发送视频消息（主动 API 模式）
 */
export async function sendVideoProactive(
  config: DingtalkConfig,
  target: any,
  videoMediaId: string,
  picMediaId: string,
  metadata?: { duration: number; width: number; height: number },
  log?: any,
): Promise<void> {
  try {
    const token = await (await import('../utils/index.ts')).getAccessToken(config);
    const { DINGTALK_API } = await import('../utils/index.ts');

    // 钉钉普通消息 API 的视频消息格式
    const msgParam = {
      duration: metadata?.duration.toString() || '60000',
      videoMediaId: videoMediaId,
      videoType: 'mp4',
      picMediaId: picMediaId || '', // 封面图 mediaId
    };

    const body: any = {
      robotCode: String(config.clientId),
      msgKey: 'sampleVideo',
      msgParam: JSON.stringify(msgParam),
    };

    let endpoint: string;
    if (target.type === 'group') {
      body.openConversationId = target.openConversationId;
      endpoint = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
    } else {
      body.userIds = [target.userId];
      endpoint = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
    }

    log?.info?.(`Video[Proactive] 发送视频消息`);
    log?.info?.(`Video[Proactive] 请求体: ${JSON.stringify(body, null, 2)}`);
    log?.info?.(`Video[Proactive] endpoint: ${endpoint}`);
    const resp = await dingtalkHttp.post(endpoint, body, {
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });

    log?.info?.(`Video[Proactive] 钉钉 API 响应: ${JSON.stringify(resp.data, null, 2)}`);

    if (resp.data?.processQueryKey) {
      log?.info?.(`Video[Proactive] 视频消息发送成功`);
    } else {
      log?.error?.(`Video[Proactive] 视频消息发送失败: ${JSON.stringify(resp.data)}`);
      throw new Error(`视频消息发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: any) {
    log?.error?.(`Video[Proactive] 发送视频消息失败, 错误: ${err.message}`);
  }
}


/**
 * 发送音频消息（sessionWebhook 模式）
 */
async function sendAudioMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  fileName: string,
  mediaId: string,
  log?: any,
  durationMs?: number,
): Promise<void> {
  try {
    const token = await (await import('../utils/index.ts')).getAccessToken(config);

    // 钉钉语音消息格式
    const actualDuration = (durationMs && durationMs > 0) ? durationMs.toString() : '60000';
    const audioMessage = {
      msgtype: 'voice',
      voice: {
        mediaId: mediaId,
        duration: actualDuration,
      },
    };

    log?.info?.(`发送语音消息: ${fileName}`);
    const resp = await dingtalkHttp.post(sessionWebhook, audioMessage, {
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });

    if (resp.data?.success !== false) {
      log?.info?.(`语音消息发送成功: ${fileName}`);
    } else {
      log?.error?.(`语音消息发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: any) {
    log?.error?.(`发送语音消息异常: ${fileName}, 错误: ${err.message}`);
  }
}

/**
 * 发送音频消息（主动 API 模式）
 */
export async function sendAudioProactive(
  config: DingtalkConfig,
  target: any,
  fileName: string,
  mediaId: string,
  log?: any,
  durationMs?: number,
): Promise<void> {
  try {
    const token = await (await import('../utils/index.ts')).getAccessToken(config);
    const { DINGTALK_API } = await import('../utils/index.ts');

    // 钉钉普通消息 API 的音频消息格式
    const actualDuration = (durationMs && durationMs > 0) ? durationMs.toString() : '60000';
    const msgParam = {
      mediaId: mediaId,
      duration: actualDuration,
    };

    const body: any = {
      robotCode: String(config.clientId),
      msgKey: 'sampleAudio',
      msgParam: JSON.stringify(msgParam),
    };

    let endpoint: string;
    if (target.type === 'group') {
      body.openConversationId = target.openConversationId;
      endpoint = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
    } else {
      body.userIds = [target.userId];
      endpoint = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
    }

    log?.info?.(`Audio[Proactive] 发送音频消息: ${fileName}`);
    const resp = await dingtalkHttp.post(endpoint, body, {
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });

    if (resp.data?.processQueryKey) {
      log?.info?.(`Audio[Proactive] 音频消息发送成功: ${fileName}`);
    } else {
      log?.warn?.(`Audio[Proactive] 音频消息发送响应异常: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: any) {
    log?.error?.(`Audio[Proactive] 发送音频消息失败: ${fileName}, 错误: ${err.message}`);
  }
}


/**
 * 发送文件消息（sessionWebhook 模式）
 */
async function sendFileMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  fileInfo: FileInfo,
  mediaId: string,
  log?: any,
): Promise<void> {
  try {
    const token = await (await import('../utils/index.ts')).getAccessToken(config);

    const fileMessage = {
      msgtype: 'file',
      file: {
        mediaId: mediaId,
        fileName: fileInfo.fileName,
        fileType: fileInfo.fileType,
      },
    };

    log?.info?.(`发送文件消息: ${fileInfo.fileName}`);
    const resp = await dingtalkHttp.post(sessionWebhook, fileMessage, {
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });

    if (resp.data?.success !== false) {
      log?.info?.(`文件消息发送成功: ${fileInfo.fileName}`);
    } else {
      log?.error?.(`文件消息发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: any) {
    log?.error?.(`发送文件消息异常: ${fileInfo.fileName}, 错误: ${err.message}`);
    throw err;
  }
}

/**
 * 发送文件消息（主动 API 模式）
 */
export async function sendFileProactive(
  config: DingtalkConfig,
  target: any,
  fileInfo: FileInfo,
  mediaId: string,
  log?: any,
): Promise<void> {
  try {
    const token = await (await import('../utils/index.ts')).getAccessToken(config);
    const { DINGTALK_API } = await import('../utils/index.ts');

    // 钉钉普通消息 API 的文件消息格式
    const resolvedFileName = fileInfo.fileName || path.basename(fileInfo.path);
    const resolvedFileType = fileInfo.fileType || resolvedFileName.split('.').pop() || 'file';
    const msgParam = {
      mediaId: mediaId,
      fileName: resolvedFileName,
      fileType: resolvedFileType,
    };

    const body: any = {
      robotCode: String(config.clientId),
      msgKey: 'sampleFile',
      msgParam: JSON.stringify(msgParam),
    };

    let endpoint: string;
    if (target.type === 'group') {
      body.openConversationId = target.openConversationId;
      endpoint = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
    } else {
      body.userIds = [target.userId];
      endpoint = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
    }

    log?.info?.(`File[Proactive] 发送文件消息: ${fileInfo.fileName}`);
    const resp = await dingtalkHttp.post(endpoint, body, {
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });

    if (resp.data?.processQueryKey) {
      log?.info?.(`File[Proactive] 发送成功: processQueryKey=${resp.data.processQueryKey}`);
    } else {
      log?.warn?.(`File[Proactive] 发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: any) {
    log?.error?.(`File[Proactive] 发送文件消息失败: ${fileInfo.fileName}, 错误: ${err.message}`);
    throw err;
  }
}

// 裸露文件路径处理（绕过 OpenClaw SDK bug）

/**
 * 检测并处理响应中的裸露本地文件路径
 * 
 * OpenClaw SDK 会自动检测响应中的裸露文件路径并调用 ctx.outbound.sendMedia，
 * 但是 SDK 传递了错误的 to 参数（accountId 而不是真实的用户 ID）。
 * 
 * 为了绕过这个 bug，我们在 SDK 检测到之前就处理这些文件路径：
 * 1. 检测裸露的本地文件路径（如 /Users/xxx/video.mp4）
 * 2. 上传文件到钉钉
 * 3. 发送媒体消息
 * 4. 从响应中移除文件路径
 * 
 * 这样 SDK 就检测不到文件路径，也就不会调用 sendMedia 了。
 */
interface AICardTarget {
  type: 'user' | 'group';
  userId?: string;
  openConversationId?: string;
}

export async function processRawMediaPaths(
  content: string,
  config: DingtalkConfig,
  oapiToken: string,
  log?: any,
  target?: AICardTarget,
): Promise<string> {
  const logPrefix = 'RawMedia';
  
  // 匹配裸露的本地文件路径（绝对路径）
  // 支持的格式：
  // - Unix: /path/to/file.ext
  // - Windows: C:\path\to\file.ext 或 C:/path/to/file.ext
  const rawPathPattern = /(?:^|\s)((?:[A-Za-z]:)?[\/\\](?:[^\/\\:\*\?"<>\|\s]+[\/\\])*[^\/\\:\*\?"<>\|\s]+\.(?:mp4|avi|mov|wmv|flv|mkv|webm|mp3|wav|flac|aac|ogg|m4a|wma|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar|7z|tar|gz))(?:\s|$)/gi;
  
  const matches = Array.from(content.matchAll(rawPathPattern));
  
  if (matches.length === 0) {
    return content;
  }
  
  log?.info?.(`${logPrefix} 检测到 ${matches.length} 个裸露的本地文件路径`);
  
  let processedContent = content;
  const statusMessages: string[] = [];
  
  for (const match of matches) {
    const fullMatch = match[0];
    const filePath = match[1].trim();
    
    try {
      log?.info?.(`${logPrefix} 开始处理文件: ${filePath}`);
      
      // 判断文件类型
      const ext = filePath.toLowerCase().split('.').pop() || '';
      let mediaType: 'video' | 'voice' | 'file';
      
      if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'].includes(ext)) {
        mediaType = 'video';
      } else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) {
        mediaType = 'voice';  // 钉钉 API 中音频类型是 'voice'
      } else {
        mediaType = 'file';
      }
      
      // 上传文件到钉钉
      const uploadResult = await uploadMediaToDingTalk(
        filePath,
        mediaType,
        oapiToken,
        20 * 1024 * 1024,
        log
      );
      
      if (!uploadResult) {
        log?.error?.(`${logPrefix} 文件上传失败: ${filePath}`);
        statusMessages.push(`⚠️ 文件上传失败: ${filePath}`);
        continue;
      }
      
      // 发送媒体消息
      const fileName = filePath.split(/[\/\\]/).pop() || 'unknown';
      
      if (mediaType === 'video') {
        // 提取视频元数据
        const metadata = await extractVideoMetadata(filePath, log);
        
        if (target) {
          // 视频消息需要原始 mediaId（带 @）
          await sendVideoProactive(config, target, uploadResult.mediaId, fileName, log, metadata);
        }
        statusMessages.push(`✅ 视频已发送: ${fileName}`);
      } else if (mediaType === 'voice') {
        // 提取音频时长
        const durationMs = await extractAudioDuration(filePath, log);
        
        if (target) {
          // 音频消息使用下载链接
          await sendAudioProactive(config, target, fileName, uploadResult.downloadUrl, log, durationMs ?? undefined);
        }
        statusMessages.push(`✅ 音频已发送: ${fileName}`);
      } else {
        // 文件消息
        const fileInfo: FileInfo = {
          path: filePath,
          fileName: fileName,
          fileType: ext,
        };
        
        if (target) {
          await sendFileProactive(config, target, fileInfo, uploadResult.mediaId, log);
        }
        statusMessages.push(`✅ 文件已发送: ${fileName}`);
      }
      
      // 从响应中移除文件路径
      processedContent = processedContent.replace(fullMatch, fullMatch.replace(filePath, ''));
      
      log?.info?.(`${logPrefix} 文件处理完成: ${fileName}`);
    } catch (err: any) {
      log?.error?.(`${logPrefix} 处理文件失败: ${filePath}, 错误: ${err.message}`);
      statusMessages.push(`⚠️ 处理失败: ${filePath}`);
    }
  }
  
  // 添加状态消息到响应中
  if (statusMessages.length > 0) {
    const statusText = '\n\n' + statusMessages.join('\n');
    processedContent = processedContent.trim() + statusText;
  }
  
  return processedContent;
}
