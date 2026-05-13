/**
 * 视频处理模块
 * 支持视频元数据提取、封面生成、视频消息发送
 */

import type { DingtalkConfig } from '../../types/index.ts';
import { VIDEO_MARKER_PATTERN, toLocalPath, uploadMediaToDingTalk } from './common.ts';
import * as fs from 'fs';

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
          log?.warn?.(`[DingTalk][Video] ffprobe 执行失败：${err.message}`);
          resolve(null);
          return;
        }
        try {
          const duration = metadata.format?.duration ? Math.floor(parseFloat(metadata.format.duration)) : 0;
          const videoStream = metadata.streams?.find((s: any) => s.codec_type === 'video');
          const width = videoStream?.width || 0;
          const height = videoStream?.height || 0;
          resolve({ duration, width, height });
        } catch (err) {
          log?.warn?.(`[DingTalk][Video] 解析 ffprobe 输出失败`);
          resolve(null);
        }
      });
    });
  } catch (err: any) {
    log?.warn?.(`[DingTalk][Video] 提取视频元数据失败：${err.message}`);
    return null;
  }
}

/**
 * 生成视频封面图（第 1 秒截图）
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
          log?.info?.(`[DingTalk][Video] 封面生成成功：${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err: any) => {
          log?.error?.(`[DingTalk][Video] 封面生成失败：${err.message}`);
          resolve(null);
        });
    });
  } catch (err: any) {
    log?.error?.(`[DingTalk][Video] ffmpeg 失败：${err.message}`);
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
  const logPrefix = useProactiveApi ? '[DingTalk][Video][Proactive]' : '[DingTalk][Video]';

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过视频处理`);
    return content;
  }

  const matches = [...content.matchAll(VIDEO_MARKER_PATTERN)];
  if (matches.length === 0) {
    log?.info?.(`${logPrefix} 未检测到视频标记，跳过处理`);
    return content;
  }
  const videoInfos: VideoInfo[] = [];
  const invalidVideos: string[] = [];

  for (const match of matches) {
    try {
      const videoData = JSON.parse(match[1]);
      const rawPath = videoData.path;
      const absPath = toLocalPath(rawPath);
      videoInfos.push({ path: absPath });
    } catch (err) {
      log?.warn?.(`${logPrefix} 解析视频标记失败：${match[1]}`);
      invalidVideos.push(match[1]);
    }
  }

  if (videoInfos.length === 0) {
    // 只有无效标记时，也要移除标记避免原样输出
    if (invalidVideos.length > 0) {
      log?.warn?.(`${logPrefix} 检测到无效视频标记，已忽略并移除`);
      return content.replaceAll(VIDEO_MARKER_PATTERN, '').trim();
    }
    return content;
  }

  log?.info?.(`${logPrefix} 检测到 ${videoInfos.length} 个视频，开始上传...`);

  let result = content;
  for (const match of matches) {
    const full = match[0];
    try {
      const videoData = JSON.parse(match[1]);
      const absPath = toLocalPath(videoData.path);
      if (!fs.existsSync(absPath)) {
        log?.warn?.(`${logPrefix} 视频文件不存在：${absPath}`);
        result = result.replace(full, '⚠️ 视频文件不存在');
        continue;
      }
      const mediaId = await uploadMediaToDingTalk(absPath, 'video', oapiToken, 20 * 1024 * 1024, log);
      result = result.replace(full, mediaId ? `[视频已上传：${mediaId}]` : '⚠️ 视频上传失败');
    } catch {
      log?.warn?.(`${logPrefix} 解析视频标记失败：${match[1]}`);
      result = result.replace(full, '');
    }
  }

  return result;
}
