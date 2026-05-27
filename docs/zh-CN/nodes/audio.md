---
read_when:
  - 更改音频转录或媒体处理方式
summary: 入站音频/语音消息如何被下载、转录并注入回复
title: 音频与语音消息
x-i18n:
  generated_at: "2026-02-01T21:17:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b926c47989ab0d1ee1fb8ae6372c51d27515b53d6fefe211a85856d372f14569
  source_path: nodes/audio.md
  workflow: 15
---

# 音频 / 语音消息 — 2026-01-17

## 已支持的功能

- **媒体理解（音频）**：如果音频理解已启用（或自动检测），OpenClaw 会：
  1. 找到第一个音频附件（本地路径或 URL），如有需要则下载。
  2. 在发送给每个模型条目之前执行 `maxBytes` 限制。
  3. 按顺序运行第一个符合条件的模型条目（提供商或 CLI）。
  4. 如果失败或跳过（大小/超时），则尝试下一个条目。
  5. 成功后，将 `Body` 替换为 `[Audio]` 块并设置 `{{Transcript}}`。
- **命令解析**：转录成功时，`CommandBody`/`RawBody` 会设置为转录文本，因此斜杠命令仍然有效。
- **详细日志**：在 `--verbose` 模式下，我们会在转录运行和替换正文时记录日志。

## 自动检测（默认）

如果你**未配置模型**且 `tools.media.audio.enabled` **未**设置为 `false`，OpenClaw 会按以下顺序自动检测，并在找到第一个可用选项时停止：

1. **本地 CLI**（如已安装）
   - `sherpa-onnx-offline`（需要 `SHERPA_ONNX_MODEL_DIR` 包含 encoder/decoder/joiner/tokens）
   - `whisper-cli`（来自 `whisper-cpp`；使用 `WHISPER_CPP_MODEL` 或内置的 tiny 模型）
   - `whisper`（Python CLI；自动下载模型）
2. **Gemini CLI**（`gemini`）使用 `read_many_files`
3. **提供商密钥**（OpenAI → Groq → Deepgram → Google）

要禁用自动检测，请设置 `tools.media.audio.enabled: false`。
要自定义，请设置 `tools.media.audio.models`。
注意：二进制检测在 macOS/Linux/Windows 上采用尽力而为的方式；请确保 CLI 在 `PATH` 中（我们会展开 `~`），或通过完整命令路径设置显式 CLI 模型。

## 配置示例

### 提供商 + CLI 回退（OpenAI + Whisper CLI）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### 仅提供商 + 作用域控制

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### 仅提供商（Deepgram）

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

## 注意事项与限制

- 提供商认证遵循标准的模型认证顺序（认证配置文件、环境变量、`models.providers.*.apiKey`）。
- 当使用 `provider: "deepgram"` 时，Deepgram 会读取 `DEEPGRAM_API_KEY`。
- Deepgram 设置详情：[Deepgram（音频转录）](/providers/deepgram)。
- 音频提供商可以通过 `tools.media.audio` 覆盖 `baseUrl`、`headers` 和 `providerOptions`。
- 默认大小限制为 20MB（`tools.media.audio.maxBytes`）。超大音频会跳过该模型并尝试下一个条目。
- 音频的默认 `maxChars` **未设置**（完整转录文本）。设置 `tools.media.audio.maxChars` 或每个条目的 `maxChars` 来裁剪输出。
- OpenAI 自动检测默认使用 `gpt-4o-mini-transcribe`；设置 `model: "gpt-4o-transcribe"` 可获得更高准确度。
- 使用 `tools.media.audio.attachments` 处理多条语音消息（`mode: "all"` + `maxAttachments`）。
- 转录文本可在模板中通过 `{{Transcript}}` 使用。
- CLI 标准输出有上限（5MB）；请保持 CLI 输出简洁。

## 常见陷阱

- 作用域规则采用首次匹配优先。`chatType` 会被规范化为 `direct`、`group` 或 `room`。
- 确保你的 CLI 以退出码 0 退出并输出纯文本；JSON 格式需要通过 `jq -r .text` 进行转换。
- 保持合理的超时时间（`timeoutSeconds`，默认 60 秒），以避免阻塞回复队列。
