#!/usr/bin/env node
/**
 * Discord WalkThink Skill
 * 自动处理Discord频道中的语音消息
 */

import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const WALKTHINK_CHANNEL_ID = "1472134303365201972";
const PROCESSOR_SCRIPT = "/Users/lizhihong/.openclaw/workspace/discord_voice_processor.py";

/**
 * 下载并处理语音消息
 */
async function processVoiceMessage(message) {
  try {
    // 检查是否是目标频道
    if (message.channelId !== WALKTHINK_CHANNEL_ID) {
      return null;
    }

    // 检查是否有音频附件
    const audioAttachment = message.attachments?.find(
      (att) =>
        att.contentType?.startsWith("audio/") || att.filename?.match(/\.(mp3|ogg|wav|m4a|opus)$/i),
    );

    if (!audioAttachment) {
      return null;
    }

    console.log(`🎙️ 检测到语音消息: ${audioAttachment.filename}`);
    console.log(`📁 URL: ${audioAttachment.url}`);

    // 下载音频文件到临时目录
    const tempFile = join(tmpdir(), `discord_voice_${Date.now()}_${audioAttachment.filename}`);

    const response = await fetch(audioAttachment.url);
    const buffer = await response.arrayBuffer();
    await writeFile(tempFile, Buffer.from(buffer));

    console.log(`💾 音频已保存: ${tempFile}`);

    // 调用处理脚本
    const result = await new Promise((resolve, reject) => {
      const proc = spawn("python3", [
        PROCESSOR_SCRIPT,
        tempFile,
        "--user-id",
        message.author?.id || "unknown",
        "--channel-id",
        message.channelId,
        "--timestamp",
        new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
      ]);

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
        console.log(data.toString());
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
        console.error(data.toString());
      });

      proc.on("close", (code) => {
        // 清理临时文件
        unlink(tempFile).catch((err) => console.error("清理临时文件失败:", err));

        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          reject(new Error(`处理失败 (退出码: ${code})\n${stderr}`));
        }
      });
    });

    return {
      reply: "✅ 语音已记录并处理完成",
      success: true,
    };
  } catch (error) {
    console.error("❌ 处理语音消息时出错:", error);
    return {
      reply: `❌ 语音处理失败: ${error.message}`,
      success: false,
    };
  }
}

// 导出skill配置
export const config = {
  name: "discord-walkthink",
  description: "Discord WalkThink语音自动处理",
  version: "1.0.1", // Bump version
  triggers: {
    channels: ["discord"],
    messageTypes: ["message", "voice", "audio", "file"],
  },
};

/**
 * Skill入口函数
 */
export async function onMessage(context) {
  const { message, reply } = context;

  console.log(`[Discord-WalkThink] 收到消息: ${message.id} (Type: ${message.type})`);
  console.log(`[Discord-WalkThink] 附件数: ${message.attachments?.length || 0}`);
  if (message.attachments?.length > 0) {
    console.log(`[Discord-WalkThink] 附件详情: ${JSON.stringify(message.attachments)}`);
  }

  // 只处理Discord消息
  if (message.platform !== "discord") {
    return;
  }

  // 处理语音消息
  const result = await processVoiceMessage(message);

  if (result && result.reply) {
    await reply(result.reply);
  } else {
    console.log(`[Discord-WalkThink] 消息未被识别为有效语音`);
  }
}
