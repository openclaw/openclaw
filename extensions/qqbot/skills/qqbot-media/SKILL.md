---
name: qqbot-media
description: QQBot rich media send and receive support. Use <qqmedia> tags only for explicit media send/view requests, treating inbound attachment paths as private current-conversation context.
metadata: { "openclaw": { "emoji": "📸", "requires": { "config": ["channels.qqbot"] } } }
---

# QQBot 富媒体收发

## 用法

```
<qqmedia>路径或URL</qqmedia>
```

系统根据文件扩展名自动识别类型并路由：

- `.jpg/.png/.gif/.webp/.bmp` → 图片
- `.silk/.wav/.mp3/.ogg/.aac/.flac` 等 → 语音
- `.mp4/.mov/.avi/.mkv/.webm` 等 → 视频
- 其他扩展名 → 文件
- 无扩展名的 URL → 默认按图片处理

## 接收媒体

- 用户发来的**图片**会由 QQBot 运行时下载到 OpenClaw 管理的 QQBot media 目录，路径只作为当前会话的附件上下文使用。
- 用户发来的**语音**路径在上下文中；若有 STT 能力则优先转写。
- 附件路径和远程 URL 可能包含用户私有内容。不要无关输出本地绝对路径，不要把附件转发到其他会话；只有用户明确要求回发、分析或转存该媒体时才使用。
- 不承诺长期保留附件。若用户需要长期保存，说明应由用户自行保存或重新发送。

## 规则

1. **路径必须是绝对路径**（以 `/` 或 `http` 开头）
2. **标签必须用开闭标签包裹路径**：`<qqmedia>路径</qqmedia>`
3. **待发送的本地文件须落在 OpenClaw 媒体目录下**：生成、下载或复制出的文件应写入 **`~/.openclaw/media/qqbot/`**（或其子目录），再写进 `<qqmedia>`。不要只放在 `~/.openclaw/workspace/` 等工作区根目录——平台安全策略只允许从 `~/.openclaw/media/`（含 `media/qqbot`）等受信根路径上传，否则会拦截、发不出去。
4. **文件大小上限**：图片 30MB / 视频 100MB / 文件 100MB / 语音 20MB
5. **你有能力发送本地图片/文件**，直接用标签包裹路径即可，**不要说"无法发送"**
6. 发送语音时不要重复语音中已朗读的文字
7. 多个媒体用多个标签
8. 以会话上下文中的能力说明为准（如未启用语音则不要发语音）
9. 不要扫描或发送上下文之外的本地文件；只使用用户提供、工具生成，或明确位于受信 media 目录中的路径
