/**
 * 音频处理模块
 * 支持音频消息发送
 */

import type { DingtalkConfig } from '../../types/index.ts';
import { AUDIO_MARKER_PATTERN, toLocalPath, uploadMediaToDingTalk } from './common.ts';
import * as fs from 'fs';

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
  const logPrefix = useProactiveApi ? '[DingTalk][Audio][Proactive]' : '[DingTalk][Audio]';

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
        result = result.replace(full, '⚠️ 音频文件不存在');
        continue;
      }
      const uploadResult = await uploadMediaToDingTalk(absPath, 'voice', oapiToken, 20 * 1024 * 1024, log);
      result = result.replace(full, uploadResult ? `[音频已上传：${uploadResult}]` : '⚠️ 音频上传失败');
    } catch {
      log?.warn?.(`${logPrefix} 解析音频标记失败：${match[1]}`);
      result = result.replace(full, '');
    }
  }

  return result.trim();
}
