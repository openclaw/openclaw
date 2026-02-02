---
read_when:
  - 修改媒体处理管道或附件
summary: 发送、Gateway网关和智能体回复的图片与媒体处理规则
title: 图片与媒体支持
x-i18n:
  generated_at: "2026-02-01T21:17:54Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 971aed398ea01078efbad7a8a4bca17f2a975222a2c4db557565e4334c9450e0
  source_path: nodes/images.md
  workflow: 15
---

# 图片与媒体支持 — 2025-12-05

WhatsApp 渠道通过 **Baileys Web** 运行。本文档记录了发送、Gateway网关和智能体回复的当前媒体处理规则。

## 目标

- 通过 `openclaw message send --media` 发送带可选说明文字的媒体。
- 允许来自 Web 收件箱的自动回复在文本旁包含媒体。
- 保持每种类型的限制合理且可预测。

## CLI 接口

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` 可选；说明文字可以为空，用于仅发送媒体。
  - `--dry-run` 打印解析后的载荷；`--json` 输出 `{ channel, to, messageId, mediaUrl, caption }`。

## WhatsApp Web 渠道行为

- 输入：本地文件路径**或** HTTP(S) URL。
- 流程：加载到 Buffer 中，检测媒体类型，并构建正确的载荷：
  - **图片：** 调整大小并重新压缩为 JPEG（最大边 2048px），目标大小为 `agents.defaults.mediaMaxMb`（默认 5 MB），上限 6 MB。
  - **音频/语音/视频：** 直通传输，上限 16 MB；音频作为语音消息发送（`ptt: true`）。
  - **文档：** 其他所有类型，上限 100 MB，可用时保留文件名。
- WhatsApp GIF 风格播放：发送带 `gifPlayback: true` 的 MP4（CLI：`--gif-playback`），使移动客户端内联循环播放。
- MIME 检测优先使用魔术字节，其次是请求头，最后是文件扩展名。
- 说明文字来自 `--message` 或 `reply.text`；允许空说明文字。
- 日志：非详细模式显示 `↩️`/`✅`；详细模式包含大小和源路径/URL。

## 自动回复管道

- `getReplyFromConfig` 返回 `{ text?, mediaUrl?, mediaUrls? }`。
- 当存在媒体时，Web 发送器使用与 `openclaw message send` 相同的管道解析本地路径或 URL。
- 如果提供了多个媒体条目，则按顺序依次发送。

## 入站媒体转命令 (Pi)

- 当入站 Web 消息包含媒体时，OpenClaw 会下载到临时文件并暴露模板变量：
  - `{{MediaUrl}}` 入站媒体的伪 URL。
  - `{{MediaPath}}` 运行命令前写入的本地临时路径。
- 当启用了每会话 Docker 沙箱时，入站媒体会被复制到沙箱工作区中，`MediaPath`/`MediaUrl` 会被重写为类似 `media/inbound/<filename>` 的相对路径。
- 媒体理解（如果通过 `tools.media.*` 或共享的 `tools.media.models` 配置）在模板化之前运行，可以将 `[Image]`、`[Audio]` 和 `[Video]` 块插入 `Body`。
  - 音频设置 `{{Transcript}}` 并使用转录文本进行命令解析，因此斜杠命令仍然有效。
  - 视频和图片描述会保留说明文字用于命令解析。
- 默认仅处理第一个匹配的图片/音频/视频附件；设置 `tools.media.<cap>.attachments` 可处理多个附件。

## 限制与错误

**出站发送上限（WhatsApp Web 发送）**

- 图片：重新压缩后约 6 MB 上限。
- 音频/语音/视频：16 MB 上限；文档：100 MB 上限。
- 超大或不可读的媒体 → 日志中显示明确错误，回复将被跳过。

**媒体理解上限（转录/描述）**

- 图片默认：10 MB（`tools.media.image.maxBytes`）。
- 音频默认：20 MB（`tools.media.audio.maxBytes`）。
- 视频默认：50 MB（`tools.media.video.maxBytes`）。
- 超大媒体会跳过理解处理，但回复仍会以原始正文发送。

## 测试注意事项

- 覆盖图片/音频/文档场景的发送 + 回复流程。
- 验证图片的重新压缩（大小限制）和音频的语音消息标志。
- 确保多媒体回复以顺序发送的方式展开。
