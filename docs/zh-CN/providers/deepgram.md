---
read_when:
  - 你想使用 Deepgram 语音转文字处理音频附件
  - 你需要一个快速的 Deepgram 配置示例
summary: Deepgram 语音转录，用于接收语音消息
title: Deepgram
x-i18n:
  generated_at: "2026-02-01T21:34:47Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8f19e072f08672116ed1a72578635c0dcebb2b1f0dfcbefa12f80b21a18ad25c
  source_path: providers/deepgram.md
  workflow: 15
---

# Deepgram（音频转录）

Deepgram 是一个语音转文字 API。在 OpenClaw 中，它通过 `tools.media.audio` 用于**接收音频/语音消息的转录**。

启用后，OpenClaw 会将音频文件上传到 Deepgram，并将转录文本注入回复管道（`{{Transcript}}` + `[Audio]` 块）。这**不是流式**处理；它使用的是预录音转录端点。

网站：https://deepgram.com  
文档：https://developers.deepgram.com

## 快速开始

1. 设置你的 API 密钥：

```
DEEPGRAM_API_KEY=dg_...
```

2. 启用提供商：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 选项

- `model`：Deepgram 模型 ID（默认：`nova-3`）
- `language`：语言提示（可选）
- `tools.media.audio.providerOptions.deepgram.detect_language`：启用语言检测（可选）
- `tools.media.audio.providerOptions.deepgram.punctuate`：启用标点符号（可选）
- `tools.media.audio.providerOptions.deepgram.smart_format`：启用智能格式化（可选）

带语言参数的示例：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

带 Deepgram 选项的示例：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 注意事项

- 认证遵循标准提供商认证顺序；`DEEPGRAM_API_KEY` 是最简单的方式。
- 使用代理时，可通过 `tools.media.audio.baseUrl` 和 `tools.media.audio.headers` 覆盖端点或请求头。
- 输出遵循与其他提供商相同的音频规则（大小限制、超时、转录文本注入）。
