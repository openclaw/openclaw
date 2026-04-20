---
summary: "媒体生成、理解和语音功能的统一登录页面"
read_when:
  - 寻找媒体功能的概述
  - 决定配置哪个媒体提供者
  - 了解异步媒体生成如何工作
title: "媒体概述"
---

# 媒体生成与理解

OpenClaw 生成图像、视频和音乐，理解入站媒体（图像、音频、视频），并通过文本到语音大声说出回复。所有媒体功能都是工具驱动的：代理根据对话决定何时使用它们，每个工具只有在至少配置了一个支持提供者时才会出现。

## 功能概览

| 功能             | 工具             | 提供者                                                                                       | 功能                           |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| 图像生成         | `image_generate` | ComfyUI, fal, Google, MiniMax, OpenAI, Vydra                                                 | 从文本提示或参考创建或编辑图像 |
| 视频生成         | `video_generate` | Alibaba, BytePlus, ComfyUI, fal, Google, MiniMax, OpenAI, Qwen, Runway, Together, Vydra, xAI | 从文本、图像或现有视频创建视频 |
| 音乐生成         | `music_generate` | ComfyUI, Google, MiniMax                                                                     | 从文本提示创建音乐或音频轨道   |
| 文本到语音 (TTS) | `tts`            | ElevenLabs, Microsoft, MiniMax, OpenAI                                                       | 将出站回复转换为语音音频       |
| 媒体理解         | (自动)           | 任何支持视觉/音频的模型提供者，加上 CLI 回退                                                 | 总结入站图像、音频和视频       |

## 提供者功能矩阵

此表显示哪些提供者支持平台上的哪些媒体功能。

| 提供者     | 图像 | 视频 | 音乐 | TTS | STT / 转录 | 媒体理解 |
| ---------- | ---- | ---- | ---- | --- | ---------- | -------- |
| Alibaba    |      | 是   |      |     |            |          |
| BytePlus   |      | 是   |      |     |            |          |
| ComfyUI    | 是   | 是   | 是   |     |            |          |
| Deepgram   |      |      |      |     | 是         |          |
| ElevenLabs |      |      |      | 是  |            |          |
| fal        | 是   | 是   |      |     |            |          |
| Google     | 是   | 是   | 是   |     |            | 是       |
| Microsoft  |      |      |      | 是  |            |          |
| MiniMax    | 是   | 是   | 是   | 是  |            |          |
| OpenAI     | 是   | 是   |      | 是  | 是         | 是       |
| Qwen       |      | 是   |      |     |            |          |
| Runway     |      | 是   |      |     |            |          |
| Together   |      | 是   |      |     |            |          |
| Vydra      | 是   | 是   |      |     |            |          |
| xAI        |      | 是   |      |     |            |          |

<Note>
媒体理解使用在你的提供者配置中注册的任何支持视觉或音频的模型。上面的表突出显示了具有专用媒体理解支持的提供者；大多数具有多模态模型的 LLM 提供者（Anthropic、Google、OpenAI 等）在配置为活动回复模型时也可以理解入站媒体。
</Note>

## 异步生成如何工作

视频和音乐生成作为后台任务运行，因为提供者处理通常需要 30 秒到几分钟。当代理调用 `video_generate` 或 `music_generate` 时，OpenClaw 将请求提交给提供者，立即返回任务 ID，并在任务分类账中跟踪作业。代理在作业运行时继续响应其他消息。当提供者完成时，OpenClaw 唤醒代理，以便它可以将完成的媒体发布回原始频道。图像生成和 TTS 是同步的，与回复内联完成。

## 快速链接

- [图像生成](/tools/image-generation) -- 生成和编辑图像
- [视频生成](/tools/video-generation) -- 文本到视频、图像到视频和视频到视频
- [音乐生成](/tools/music-generation) -- 创建音乐和音频轨道
- [文本到语音](/tools/tts) -- 将回复转换为语音音频
- [媒体理解](/nodes/media-understanding) -- 理解入站图像、音频和视频
