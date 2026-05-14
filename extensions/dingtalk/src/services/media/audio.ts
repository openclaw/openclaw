/**
 * 音频处理模块
 * 支持音频消息发送
 */

import * as fs from "fs";
import * as path from "path";
import type { DingtalkConfig } from "../../types/index.ts";
import { uploadMediaToDingTalk, sendAudioProactive, sendAudioMessage } from "../media.ts";
import { AUDIO_MARKER_PATTERN, toLocalPath } from "./common.ts";

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
  const logPrefix = useProactiveApi ? "[DingTalk][Audio][Proactive]" : "[DingTalk][Audio]";

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过音频处理`);
    return content;
  }

  const matches = [...content.matchAll(AUDIO_MARKER_PATTERN)];
  if (matches.length === 0) return content;

  log?.info?.(`${logPrefix} 检测到 ${matches.length} 个音频，开始上传...`);

  let result = content;
  for (const match of matches) {
    const full = match[0];
    try {
      const audioData = JSON.parse(match[1]);
      const absPath = toLocalPath(audioData.path);
      if (!fs.existsSync(absPath)) {
        log?.warn?.(`${logPrefix} 音频文件不存在：${absPath}`);
        result = result.replace(full, "⚠️ 音频文件不存在");
        continue;
      }
      const uploadResult = await uploadMediaToDingTalk(
        absPath,
        "voice",
        oapiToken,
        2 * 1024 * 1024,
        log,
      );
      if (!uploadResult) {
        result = result.replace(full, "⚠️ 音频上传失败");
        continue;
      }

      const fileName = path.basename(absPath);
      if (useProactiveApi && target) {
        await sendAudioProactive(config, target, fileName, uploadResult.downloadUrl, log);
      } else {
        await sendAudioMessage(config, sessionWebhook, fileName, uploadResult.downloadUrl, log);
      }
      result = result.replace(full, `✅ 音频已发送: ${fileName}`);
    } catch {
      log?.warn?.(`${logPrefix} 解析音频标记失败：${match[1]}`);
      result = result.replace(full, "");
    }
  }

  return result.trim();
}
