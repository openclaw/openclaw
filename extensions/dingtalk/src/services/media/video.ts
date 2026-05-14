/**
 * 视频处理模块
 * 支持视频元数据提取、封面生成、视频消息发送
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DingtalkConfig } from "../../types/index.ts";
import {
  uploadMediaToDingTalk,
  extractVideoMetadata,
  extractVideoThumbnail,
  sendVideoProactive,
  sendVideoMessage,
} from "../media.ts";
import { VIDEO_MARKER_PATTERN, toLocalPath } from "./common.ts";

/** 视频信息接口 */
export interface VideoInfo {
  path: string;
}

export { extractVideoMetadata, extractVideoThumbnail };

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
  const logPrefix = useProactiveApi ? "[DingTalk][Video][Proactive]" : "[DingTalk][Video]";

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
      if (fs.existsSync(absPath)) {
        videoInfos.push({ path: absPath });
      } else {
        invalidVideos.push(absPath);
        log?.warn?.(`${logPrefix} 视频文件不存在: ${absPath}`);
      }
    } catch (err) {
      log?.warn?.(`${logPrefix} 解析视频标记失败：${match[1]}`);
      invalidVideos.push(match[1]);
    }
  }

  let cleanedContent = content.replace(VIDEO_MARKER_PATTERN, "").trim();
  const statusMessages: string[] = [];

  for (const invalidPath of invalidVideos) {
    statusMessages.push(`⚠️ 视频文件不存在: ${path.basename(invalidPath)}`);
  }

  if (videoInfos.length === 0) {
    if (statusMessages.length > 0) {
      cleanedContent = cleanedContent
        ? `${cleanedContent}\n\n${statusMessages.join("\n")}`
        : statusMessages.join("\n");
    }
    return cleanedContent;
  }

  log?.info?.(`${logPrefix} 检测到 ${videoInfos.length} 个视频，开始上传...`);

  for (const videoInfo of videoInfos) {
    const fileName = path.basename(videoInfo.path);
    let thumbnailPath = "";
    try {
      const metadata = await extractVideoMetadata(videoInfo.path, log);
      if (!metadata) {
        log?.warn?.(`${logPrefix} 无法提取元数据: ${videoInfo.path}`);
        statusMessages.push(`⚠️ 视频处理失败: ${fileName}（无法读取视频信息）`);
        continue;
      }

      thumbnailPath = path.join(
        os.tmpdir(),
        `thumbnail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`,
      );
      const thumbnail = await extractVideoThumbnail(videoInfo.path, thumbnailPath, log);
      if (!thumbnail) {
        statusMessages.push(`⚠️ 视频处理失败: ${fileName}（无法生成封面）`);
        continue;
      }

      const videoUploadResult = await uploadMediaToDingTalk(
        videoInfo.path,
        "video",
        oapiToken,
        20 * 1024 * 1024,
        log,
      );
      if (!videoUploadResult) {
        statusMessages.push(`⚠️ 视频上传失败: ${fileName}`);
        continue;
      }

      const picUploadResult = await uploadMediaToDingTalk(
        thumbnailPath,
        "image",
        oapiToken,
        20 * 1024 * 1024,
        log,
      );
      const picMediaId = picUploadResult?.mediaId ?? "";

      if (useProactiveApi && target) {
        await sendVideoProactive(
          config,
          target,
          videoUploadResult.mediaId,
          picMediaId,
          metadata,
          log,
        );
      } else {
        await sendVideoMessage(
          config,
          sessionWebhook,
          fileName,
          videoUploadResult.downloadUrl,
          log,
          metadata,
        );
      }

      statusMessages.push(`✅ 视频已发送: ${fileName}`);
    } catch (err: any) {
      log?.error?.(`${logPrefix} 处理视频失败: ${err.message}`);
      statusMessages.push(`⚠️ 视频处理异常: ${fileName}（${err.message}）`);
    } finally {
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        try {
          fs.unlinkSync(thumbnailPath);
        } catch {}
      }
    }
  }

  if (statusMessages.length > 0) {
    const statusText = statusMessages.join("\n");
    cleanedContent = cleanedContent ? `${cleanedContent}\n\n${statusText}` : statusText;
  }

  return cleanedContent;
}
