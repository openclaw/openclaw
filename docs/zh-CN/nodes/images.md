---
read_when:
  - 修改媒体管道或附件
summary: 发送、Gateway 网关和智能体回复的图像和媒体处理规则
title: 图像和媒体支持
x-i18n:
  generated_at: "2026-02-03T07:50:42Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 971aed398ea01078efbad7a8a4bca17f2a975222a2c4db557565e4334c9450e0
  source_path: nodes/images.md
  workflow: 15
---

# 图像与媒体支持 — 2025-12-05

WhatsApp 渠道通过 **Baileys Web** 运行。本文档记录了发送、Gateway 网关和智能体回复的当前媒体处理规则。

## 目标

- 通过 `openclaw message send --media` 发送带可选标题的媒体。
- 允许来自网页收件箱的自动回复在文本旁边包含媒体。
- 保持每种类型的限制合理且可预测。

## CLI 接口

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 可选；标题可以为空以进行纯媒体发送。
  - `--dry-run` 打印解析后的负载；`--json` 输出 `{ channel, to, messageId, mediaUrl, caption }`。

## WhatsApp Web 渠道行为

- 输入：本地文件路径**或** HTTP(S) URL。
- 流程：加载到 Buffer，检测媒体类型，并构建正确的负载：
  - **图像：** 调整大小并重新压缩为 JPEG（最大边 2048px），目标为 `agents.defaults.mediaMaxMb`（默认 5 MB），上限 6 MB。
  - **音频/语音/视频：** 直通最大 16 MB；音频作为语音消息发送（`ptt: true`）。
  - **文档：** 其他任何内容，最大 100 MB，可用时保留文件名。
- WhatsApp GIF 风格播放：发送带 `gifPlayback: true` 的 MP4（CLI：`--gif-playback`），使移动客户端内联循环播放。
- MIME 检测优先使用魔数字节，然后是头信息，最后是文件扩展名。
- 标题来自 `--message` 或 `reply.text`；允许空标题。
- 日志：非详细模式显示 `↩️`/`✅`；详细模式包含大小和源路径/URL。

## 自动回复管道

- `getReplyFromConfig` 返回 `{ text?, mediaUrl?, mediaUrls? }`。
- 当存在媒体时，网页发送器使用与 `openclaw message send` 相同的管道解析本地路径或 URL。
- 如果提供多个媒体条目，则按顺序发送。

## 入站媒体到命令（Pi）

- 当入站网页消息包含媒体时，OpenClaw 下载到临时文件并暴露模板变量：
  - `{{MediaUrl}}` 入站媒体的伪 URL。
  - `{{MediaPath}}` 运行命令前写入的本地临时路径。
- 当启用每会话 Docker 沙箱时，入站媒体被复制到沙箱工作区，`MediaPath`/`MediaUrl` 被重写为相对路径如 `media/inbound/<filename>`。
- 媒体理解（如果通过 `tools.media.*` 或共享的 `tools.media.models` 配置）在模板化之前运行，可以将 `[Image]`、`[Audio]` 和 `[Video]` 块插入 `Body`。
  - 音频设置 `{{Transcript}}` 并使用转录进行命令解析，因此斜杠命令仍然有效。
  - 视频和图像描述保留任何标题文本用于命令解析。
- 默认情况下只处理第一个匹配的图像/音频/视频附件；设置 `tools.media.<cap>.attachments` 以处理多个附件。

## 限制与错误

**出站发送上限（WhatsApp 网页发送）**

- 图像：重新压缩后约 6 MB 上限。
- 音频/语音/视频：16 MB 上限；文档：100 MB 上限。
- 超大或无法读取的媒体 → 日志中有明确错误，回复被跳过。

**媒体理解上限（转录/描述）**

- 图像默认：10 MB（`tools.media.image.maxBytes`）。
- 音频默认：20 MB（`tools.media.audio.maxBytes`）。
- 视频默认：50 MB（`tools.media.video.maxBytes`）。
- 超大媒体跳过理解，但回复仍然使用原始正文通过。

## 测试说明

- 覆盖图像/音频/文档情况的发送 + 回复流程。
- 验证图像的重新压缩（大小限制）和音频的语音消息标志。
- 确保多媒体回复作为顺序发送扇出。
