---
summary: "用于出站回复的文本转语音（TTS）"
read_when:
  - 启用回复的文本转语音
  - 配置 TTS 提供商或限制
  - 使用 /tts 命令
title: "Text-to-Speech"
---

# Text-to-speech (TTS)

OpenClaw 可以使用 ElevenLabs、Microsoft 或 OpenAI 将出站回复转换为音频。它可以在 OpenClaw 能发送音频的任何地方工作。

## 支持的服务

- **ElevenLabs**（主要或后备提供商）
- **Microsoft**（主要或后备提供商；当前捆绑实现使用 `node-edge-tts`）
- **OpenAI**（主要或后备提供商；也用于摘要）

### Microsoft 语音说明

捆绑的 Microsoft 语音提供商当前通过 `node-edge-tts` 库使用 Microsoft Edge 的在线神经 TTS 服务。这是一个托管服务（不是本地），使用 Microsoft 端点，不需要 API 密钥。`node-edge-tts` 暴露语音配置选项和输出格式，但并非所有选项都受服务支持。使用 `edge` 的旧版配置和指令输入仍然有效，并规范化为 `microsoft`。

因为此路径是没有公布 SLA 或配额的公共服务，所以将其视为尽力而为。如果您需要保证的限制和支持，请使用 OpenAI 或 ElevenLabs。

## 可选密钥

如果您想要 OpenAI 或 ElevenLabs：

- `ELEVENLABS_API_KEY`（或 `XI_API_KEY`）
- `OPENAI_API_KEY`

Microsoft 语音**不需要** API 密钥。

如果配置了多个提供商，则首先使用选定的提供商，其他提供商作为后备选项。自动摘要使用配置的 `summaryModel`（或 `agents.defaults.model.primary`），因此如果您启用摘要，该提供商也必须经过身份验证。

## 服务链接

- [OpenAI Text-to-Speech 指南](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API 参考](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 身份验证](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech 输出格式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 默认启用吗？

不。自动 TTS 默认**关闭**。在配置中使用 `messages.tts.auto` 启用，或在每次会话中使用 `/tts always`（别名：`/tts on`）。

当 `messages.tts.provider` 未设置时，OpenClaw 按注册表自动选择顺序选择第一个配置的语音提供商。

## 配置

TTS 配置位于 `openclaw.json` 的 `messages.tts` 下。完整模式在 [Gateway 配置](/gateway/configuration) 中。

### 最小配置（启用 + 提供商）

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI 主要 + ElevenLabs 后备

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      providers: {
        openai: {
          apiKey: "openai_api_key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
        elevenlabs: {
          apiKey: "elevenlabs_api_key",
          baseUrl: "https://api.elevenlabs.io",
          voiceId: "voice_id",
          modelId: "eleven_multilingual_v2",
          seed: 42,
          applyTextNormalization: "auto",
          languageCode: "en",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            style: 0.0,
            useSpeakerBoost: true,
            speed: 1.0,
          },
        },
      },
    },
  },
}
```

### Microsoft 主要（无 API 密钥）

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "microsoft",
      providers: {
        microsoft: {
          enabled: true,
          voice: "en-US-MichelleNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          rate: "+10%",
          pitch: "-5%",
        },
      },
    },
  },
}
```

### 禁用 Microsoft 语音

```json5
{
  messages: {
    tts: {
      providers: {
        microsoft: {
          enabled: false,
        },
      },
    },
  },
}
```

### 自定义限制 + prefs 路径

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### 仅在入站语音消息后回复音频

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 禁用长回复的自动摘要

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

然后运行：

```
/tts summary off
```

### 字段说明

- `auto`：自动 TTS 模式（`off`、`always`、`inbound`、`tagged`）。
  - `inbound` 仅在入站语音消息后发送音频。
  - `tagged` 仅在回复包含 `[[tts]]` 标签时发送音频。
- `enabled`：旧版开关（doctor 将此迁移到 `auto`）。
- `mode`：`"final"`（默认）或 `"all"`（包括工具/阻止回复）。
- `provider`：语音提供商 ID，如 `"elevenlabs"`、`"microsoft"` 或 `"openai"`（后备是自动的）。
- 如果 `provider` **未设置**，OpenClaw 使用注册表自动选择顺序中第一个配置的语音提供商。
- 旧版 `provider: "edge"` 仍然有效，并规范化为 `microsoft`。
- `summaryModel`：用于自动摘要的可选廉价模型；默认为 `agents.defaults.model.primary`。
  - 接受 `provider/model` 或配置的模型别名。
- `modelOverrides`：允许模型发出 TTS 指令（默认开启）。
  - `allowProvider` 默认为 `false`（提供商切换是选择性加入）。
- `providers.<id>`：按语音提供商 ID 键入的提供商自有设置。
- `maxTextLength`：TTS 输入的硬上限（字符）。如果超过，`/tts audio` 会失败。
- `timeoutMs`：请求超时（毫秒）。
- `prefsPath`：覆盖本地 prefs JSON 路径（提供商/限制/摘要）。
- `apiKey` 值回退到环境变量（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）。
- `providers.elevenlabs.baseUrl`：覆盖 ElevenLabs API 基础 URL。
- `providers.openai.baseUrl`：覆盖 OpenAI TTS 端点。
  - 解析顺序：`messages.tts.providers.openai.baseUrl` -> `OPENAI_TTS_BASE_URL` -> `https://api.openai.com/v1`
  - 非默认值被视为 OpenAI 兼容 TTS 端点，因此接受自定义模型和语音名称。
- `providers.elevenlabs.voiceSettings`：
  - `stability`、`similarityBoost`、`style`：`0..1`
  - `useSpeakerBoost`：`true|false`
  - `speed`：`0.5..2.0`（1.0 = 正常）
- `providers.elevenlabs.applyTextNormalization`：`auto|on|off`
- `providers.elevenlabs.languageCode`：2 字母 ISO 639-1（例如 `en`、`de`）
- `providers.elevenlabs.seed`：整数 `0..4294967295`（尽力而为的确定性）
- `providers.microsoft.enabled`：允许 Microsoft 语音使用（默认 `true`；无 API 密钥）。
- `providers.microsoft.voice`：Microsoft 神经语音名称（例如 `en-US-MichelleNeural`）。
- `providers.microsoft.lang`：语言代码（例如 `en-US`）。
- `providers.microsoft.outputFormat`：Microsoft 输出格式（例如 `audio-24khz-48kbitrate-mono-mp3`）。
  - 请参阅 Microsoft Speech 输出格式以获取有效值；并非所有格式都受捆绑的 Edge 支持传输的支持。
- `providers.microsoft.rate` / `providers.microsoft.pitch` / `providers.microsoft.volume`：百分比字符串（例如 `+10%`、`-5%`）。
- `providers.microsoft.saveSubtitles`：在音频文件旁边写入 JSON 字幕。
- `providers.microsoft.proxy`：Microsoft 语音请求的代理 URL。
- `providers.microsoft.timeoutMs`：请求超时覆盖（毫秒）。
- `edge.*`：相同 Microsoft 设置的旧版别名。

## 模型驱动的覆盖（默认开启）

默认情况下，模型**可以**为单个回复发出 TTS 指令。
当 `messages.tts.auto` 为 `tagged` 时，这些指令是触发音频所必需的。

启用后，模型可以发出 `[[tts:...]]` 指令来覆盖单个回复的语音，以及可选的 `[[tts:text]]...[[/tts:text]]` 块来提供仅应在音频中出现的表达标签（笑声、唱歌提示等）。

除非 `modelOverrides.allowProvider: true`，否则 `provider=...` 指令被忽略。

示例回复负载：

```
Here you go.

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

可用指令键（启用时）：

- `provider`（注册的语音提供商 ID，例如 `openai`、`elevenlabs` 或 `microsoft`；需要 `allowProvider: true`）
- `voice`（OpenAI 语音）或 `voiceId`（ElevenLabs）
- `model`（OpenAI TTS 模型或 ElevenLabs 模型 ID）
- `stability`、`similarityBoost`、`style`、`speed`、`useSpeakerBoost`
- `applyTextNormalization`（`auto|on|off`）
- `languageCode`（ISO 639-1）
- `seed`

禁用所有模型覆盖：

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

可选允许列表（在保持其他旋钮可配置的同时启用提供商切换）：

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: true,
        allowSeed: false,
      },
    },
  },
}
```

## 每用户偏好

斜杠命令将本地覆盖写入 `prefsPath`（默认：`~/.openclaw/settings/tts.json`，使用 `OPENCLAW_TTS_PREFS` 或 `messages.tts.prefsPath` 覆盖）。

存储的字段：

- `enabled`
- `provider`
- `maxLength`（摘要阈值；默认 1500 字符）
- `summarize`（默认 `true`）

这些覆盖该主机的 `messages.tts.*`。

## 输出格式（固定）

- **飞书 / Matrix / Telegram / WhatsApp**：Opus 语音消息（ElevenLabs 的 `opus_48000_64`，OpenAI 的 `opus`）。
  - 48kHz / 64kbps 是语音消息的良好权衡。
- **其他频道**：MP3（ElevenLabs 的 `mp3_44100_128`，OpenAI 的 `mp3`）。
  - 44.1kHz / 128kbps 是语音清晰度的默认平衡。
- **Microsoft**：使用 `microsoft.outputFormat`（默认 `audio-24khz-48kbitrate-mono-mp3`）。
  - 捆绑传输接受 `outputFormat`，但并非所有格式都可从服务获得。
  - 输出格式值遵循 Microsoft Speech 输出格式（包括 Ogg/WebM Opus）。
  - Telegram `sendVoice` 接受 OGG/MP3/M4A；如果您需要保证的 Opus 语音消息，请使用 OpenAI/ElevenLabs。
  - 如果配置的 Microsoft 输出格式失败，OpenClaw 会使用 MP3 重试。

OpenAI/ElevenLabs 输出格式是按频道固定的（见上文）。

## 自动 TTS 行为

启用后，OpenClaw：

- 如果回复已包含媒体或 `MEDIA:` 指令，则跳过 TTS。
- 跳过非常短的回复（< 10 个字符）。
- 启用时使用 `agents.defaults.model.primary`（或 `summaryModel`）总结长回复。
- 将生成的音频附加到回复。

如果回复超过 `maxLength` 且摘要关闭（或摘要模型没有 API 密钥），则跳过音频并发送正常文本回复。

## 流程图

```
回复 -> TTS 启用？
  否 -> 发送文本
  是 -> 有媒体 / MEDIA: / 短？
        是 -> 发送文本
        否 -> 长度 > 限制？
                 否 -> TTS -> 附加音频
                 是 -> 摘要启用？
                          否 -> 发送文本
                          是 -> 摘要（summaryModel 或 agents.defaults.model.primary）
                                    -> TTS -> 附加音频
```

## 斜杠命令使用

有一个命令：`/tts`。
有关启用详情，请参阅 [斜杠命令](/tools/slash-commands)。

Discord 说明：`/tts` 是内置的 Discord 命令，因此 OpenClaw 在那里注册 `/voice` 作为本机命令。文本 `/tts ...` 仍然有效。

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

说明：

- 命令需要授权发送者（允许列表/所有者规则仍然适用）。
- `commands.text` 或本机命令注册必须启用。
- `off|always|inbound|tagged` 是每次会话切换（`/tts on` 是 `/tts always` 的别名）。
- `limit` 和 `summary` 存储在本地 prefs 中，而不是主配置中。
- `/tts audio` 生成一次性音频回复（不会切换 TTS）。

## 代理工具

`tts` 工具将文本转换为语音并返回用于回复传递的音频附件。当频道是飞书、Matrix、Telegram 或 WhatsApp 时，音频作为语音消息而不是文件附件传递。

## Gateway RPC

Gateway 方法：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
