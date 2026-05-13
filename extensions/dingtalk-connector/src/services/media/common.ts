/**
 * 媒体处理公共工具和常量
 */

import * as fs from 'fs';
import * as path from 'path';
// form-data 是 CJS 模块，静态 import 可确保 jiti/ESM 环境下 CJS 互操作行为稳定，
// 避免动态 import 时 .default 偶发为 undefined 导致 "Cannot read properties of undefined (reading 'registry')"
import FormData from 'form-data';
import { createLogger } from '../../utils/logger.ts';
import { CHUNK_CONFIG } from './chunk-upload.ts';
import { dingtalkOapiHttp, dingtalkUploadHttp } from '../../utils/http-client.ts';

// ============ 常量 ============

/** 文本文件扩展名 */
export const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.css',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.sh', '.bat', '.csv',
]);

/** 图片文件扩展名 */
export const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|bmp|webp|tiff|svg)$/i;

/** 本地图片路径正则表达式（跨平台） */
export const LOCAL_IMAGE_RE =
  /!\[([^\]]*)\]\(((?:file:\/\/|MEDIA:|attachment:\/\/)[^)]+|\/(?:tmp|var|private|Users|home|root)[^)]+|[A-Za-z]:[\\/][^)]+)\)/g;

/** 纯文本图片路径正则表达式 */
export const BARE_IMAGE_PATH_RE =
  /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))`?/gi;

/** 视频标记正则表达式 */
export const VIDEO_MARKER_PATTERN = /\[DINGTALK_VIDEO\](.*?)\[\/DINGTALK_VIDEO\]/gs;

/** 音频标记正则表达式 */
export const AUDIO_MARKER_PATTERN = /\[DINGTALK_AUDIO\](.*?)\[\/DINGTALK_AUDIO\]/gs;

/** 文件标记正则表达式 */
export const FILE_MARKER_PATTERN = /\[DINGTALK_FILE\](.*?)\[\/DINGTALK_FILE\]/gs;

// ============ 工具函数 ============

/**
 * 去掉 file:// / MEDIA: / attachment:// 前缀，得到实际的绝对路径
 */
export function toLocalPath(raw: string): string {
  let filePath = raw;
  if (filePath.startsWith('file://')) filePath = filePath.replace('file://', '');
  else if (filePath.startsWith('MEDIA:')) filePath = filePath.replace('MEDIA:', '');
  else if (filePath.startsWith('attachment://')) filePath = filePath.replace('attachment://', '');

  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // 解码失败则保持原样
  }
  return filePath;
}

/**
 * 谨慎使用，返回的是cleanMediaId
 * 后续逐步删除，可用 media.ts
 */
export async function uploadMediaToDingTalk(
  filePath: string,
  mediaType: 'image' | 'file' | 'video' | 'voice',
  oapiToken: string,
  maxSize: number = 20 * 1024 * 1024,
  logOrDebug?: any,
  debug?: boolean,
): Promise<string | null> {
  const debugEnabled =
    typeof logOrDebug === 'boolean' ? logOrDebug === true : debug === true;
  const externalLog = typeof logOrDebug === 'boolean' ? undefined : logOrDebug;
  const log = externalLog ?? createLogger(debugEnabled, `DingTalk][${mediaType}`);
  
  log?.info?.(
    `[uploadMediaToDingTalk] 开始上传，filePath: ${filePath}, mediaType: ${mediaType}, debug: ${debugEnabled}`,
  );
  
  try {
    const absPath = toLocalPath(filePath);
    log?.info?.(`检查文件是否存在：${absPath}`);
    if (!fs.existsSync(absPath)) {
      log?.warn?.(`文件不存在：${absPath}`);
      return null;
    }

    const stats = fs.statSync(absPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSize = stats.size;

    // ✅ 对于视频和文件类型，如果超过 20MB，使用分块上传
    if ((mediaType === 'video' || mediaType === 'file') && fileSize > CHUNK_CONFIG.SIZE_THRESHOLD) {
      log?.info?.(`文件超过 20MB，使用分块上传：${absPath} (${fileSizeMB}MB)`);
      try {
        const { uploadLargeFileByChunks } = await import('./chunk-upload');
        const downloadCode = await uploadLargeFileByChunks(absPath, mediaType, oapiToken, debugEnabled);
        if (downloadCode) {
          log?.info?.(`分块上传成功：${absPath}, download_code: ${downloadCode}`);
          return downloadCode;
        }
        log?.error?.(`分块上传失败：${absPath}`);
      } catch (chunkErr: any) {
        log?.error?.(`分块上传异常：${chunkErr.message}`);
      }
      return null;
    }

    // 检查文件大小（对于小于 20MB 的文件）
    if (stats.size > maxSize) {
      const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(0);
      log?.warn?.(
        `文件过大：${absPath}, 大小：${fileSizeMB}MB, 超过限制 ${maxSizeMB}MB`,
      );
      return null;
    }

    const form = new FormData();
    form.append('media', fs.createReadStream(absPath), {
      filename: path.basename(absPath),
      contentType: mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream',
    });

    const uploadType = mediaType;

    log?.info?.(`上传文件：${absPath} (${fileSizeMB}MB), uploadType=${uploadType}`);
    const resp = await dingtalkUploadHttp.post(
      `${DINGTALK_OAPI}/media/upload`,
      form,
      {
        params: { access_token: oapiToken, type: mediaType },
        headers: form.getHeaders(),
        timeout: 60_000,
        maxBodyLength: Infinity,
      },
    );

    const mediaId = resp.data?.media_id;
    if (mediaId) {
      const cleanMediaId = mediaId.startsWith('@') ? mediaId.substring(1) : mediaId;
      log?.info?.(`上传成功：mediaId=${cleanMediaId}`);
      return cleanMediaId;
    }
    log?.warn?.(`上传返回无 media_id`);
    return null;
  } catch (err: any) {
    log?.error?.(`上传失败：${err.message}`);
    return null;
  }
}

/** 钉钉 OAPI 常量 */
export const DINGTALK_OAPI = 'https://oapi.dingtalk.com';