---
read_when:
  - 为回复启用文字转语音
  - 配置 TTS 提供商或限制
  - 使用 /tts 命令
summary: 用于出站回复的文字转语音（TTS）
title: 文字转语音
x-i18n:
  generated_at: "2026-02-01T21:44:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 070ff0cc8592f64c6c9e4ddaddc7e8fba82f0692ceded6fe833ec9ba5b61e6fb
  source_path: tts.md
  workflow: 15
---

# 文字转语音（TTS）

OpenClaw 可以使用 ElevenLabs、OpenAI 或 Edge TTS 将出站回复转换为音频。
它适用于 OpenClaw 能发送音频的任何地方；Telegram 会显示圆形语音消息气泡。

## 支持的服务

- **ElevenLabs**（主要或备用提供商）
- **OpenAI**（主要或备用提供商；也用于摘要）
- **Edge TTS**（主要或备用提供商；使用 `node-edge-tts`，无 API 密钥时为默认选项）

### Edge TTS 说明

Edge TTS 通过 `node-edge-tts` 库使用 Microsoft Edge 的在线神经网络 TTS 服务。它是一个托管服务（非本地），使用 Microsoft 的端点，不需要 API 密钥。`node-edge-tts` 提供了语音配置选项和输出格式，但并非所有选项都受 Edge 服务支持。citeturn2search0

由于 Edge TTS 是一个没有公开 SLA 或配额的公共网络服务，请将其视为尽力而为。如果你需要有保障的限额和支持，请使用 OpenAI 或 ElevenLabs。Microsoft 的 Speech REST API 文档记载了每次请求 10 分钟的音频限制；Edge TTS 没有公布限制，因此请假设类似或更低的限制。citeturn0search3

## 可选密钥

如果你需要使用 OpenAI 或 ElevenLabs：

- `ELEVENLABS_API_KEY`（或 `XI_API_KEY`）
- `OPENAI_API_KEY`

Edge TTS **不**需要 API 密钥。如果未找到任何 API 密钥，OpenClaw 默认使用 Edge TTS（除非通过 `messages.tts.edge.enabled=false` 禁用）。

如果配置了多个提供商，优先使用所选提供商，其他提供商作为备用选项。
自动摘要使用配置的 `summaryModel`（或 `agents.defaults.model.primary`），因此如果启用摘要功能，该提供商也必须通过认证。

## 服务链接

- [OpenAI 文字转语音指南](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI 音频 API 参考](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 文字转语音](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 认证](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft 语音输出格式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 默认启用吗？

否。自动 TTS 默认**关闭**。通过配置中的 `messages.tts.auto` 或在每个会话中使用 `/tts always`（别名：`/tts on`）启用。

TTS 开启后，Edge TTS 默认**已启用**，当没有 OpenAI 或 ElevenLabs API 密钥可用时会自动使用。

## 配置

TTS 配置位于 `openclaw.json` 中的 `messages.tts` 下。
完整 schema 请参见 [Gateway网关配置](/gateway/configuration)。

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

### OpenAI 为主、ElevenLabs 为备用

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
      openai: {
        apiKey: "openai_api_key",
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
}
```

### Edge TTS 为主（无需 API 密钥）

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### 禁用 Edge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### 自定义限制 + 偏好路径

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

### 仅在收到语音消息后回复音频

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 对长回复禁用自动摘要

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
  - `inbound` 仅在收到语音消息后发送音频。
  - `tagged` 仅在回复包含 `[[tts]]` 标签时发送音频。
- `enabled`：旧版开关（doctor 会将其迁移为 `auto`）。
- `mode`：`"final"`（默认）或 `"all"`（包括工具/块回复）。
- `provider`：`"elevenlabs"`、`"openai"` 或 `"edge"`（备用是自动的）。
- 如果 `provider` **未设置**，OpenClaw 优先使用 `openai`（如有密钥），然后 `elevenlabs`（如有密钥），否则使用 `edge`。
- `summaryModel`：可选的低成本模型用于自动摘要；默认为 `agents.defaults.model.primary`。
  - 接受 `provider/model` 或已配置的模型别名。
- `modelOverrides`：允许模型发出 TTS 指令（默认开启）。
- `maxTextLength`：TTS 输入的硬性上限（字符数）。超出时 `/tts audio` 会失败。
- `timeoutMs`：请求超时（毫秒）。
- `prefsPath`：覆盖本地偏好 JSON 路径（提供商/限制/摘要）。
- `apiKey` 值回退到环境变量（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）。
- `elevenlabs.baseUrl`：覆盖 ElevenLabs API 基础 URL。
- `elevenlabs.voiceSettings`：
  - `stability`、`similarityBoost`、`style`：`0..1`
  - `useSpeakerBoost`：`true|false`
  - `speed`：`0.5..2.0`（1.0 = 正常）
- `elevenlabs.applyTextNormalization`：`auto|on|off`
- `elevenlabs.languageCode`：2 位 ISO 639-1 代码（例如 `en`、`de`）
- `elevenlabs.seed`：整数 `0..4294967295`（尽力保证确定性）
- `edge.enabled`：允许使用 Edge TTS（默认 `true`；无需 API 密钥）。
- `edge.voice`：Edge 神经网络语音名称（例如 `en-US-MichelleNeural`）。
- `edge.lang`：语言代码（例如 `en-US`）。
- `edge.outputFormat`：Edge 输出格式（例如 `audio-24khz-48kbitrate-mono-mp3`）。
  - 有效值请参见 Microsoft 语音输出格式；并非所有格式都受 Edge 支持。
- `edge.rate` / `edge.pitch` / `edge.volume`：百分比字符串（例如 `+10%`、`-5%`）。
- `edge.saveSubtitles`：在音频文件旁写入 JSON 字幕。
- `edge.proxy`：Edge TTS 请求的代理 URL。
- `edge.timeoutMs`：请求超时覆盖（毫秒）。

## 模型驱动的覆盖（默认开启）

默认情况下，模型**可以**为单条回复发出 TTS 指令。
当 `messages.tts.auto` 为 `tagged` 时，需要这些指令才能触发音频。

启用后，模型可以发出 `[[tts:...]]` 指令来覆盖单条回复的语音，还可以使用可选的 `[[tts:text]]...[[/tts:text]]` 块来提供表现力标签（笑声、歌唱提示等），这些标签仅出现在音频中。

示例回复内容：

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

可用的指令键（启用时）：

- `provider`（`openai` | `elevenlabs` | `edge`）
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

可选允许列表（禁用特定覆盖同时保持标签启用）：

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## 用户偏好

斜杠命令将本地覆盖写入 `prefsPath`（默认：`~/.openclaw/settings/tts.json`，可通过 `OPENCLAW_TTS_PREFS` 或 `messages.tts.prefsPath` 覆盖）。

存储的字段：

- `enabled`
- `provider`
- `maxLength`（摘要阈值；默认 1500 字符）
- `summarize`（默认 `true`）

这些设置会覆盖该主机上的 `messages.tts.*`。

## 输出格式（固定）

- **Telegram**：Opus 语音消息（ElevenLabs 使用 `opus_48000_64`，OpenAI 使用 `opus`）。
  - 48kHz / 64kbps 是语音消息的良好平衡点，也是圆形气泡的必要条件。
- **其他渠道**：MP3（ElevenLabs 使用 `mp3_44100_128`，OpenAI 使用 `mp3`）。
  - 44.1kHz / 128kbps 是语音清晰度的默认平衡点。
- **Edge TTS**：使用 `edge.outputFormat`（默认 `audio-24khz-48kbitrate-mono-mp3`）。
  - `node-edge-tts` 接受 `outputFormat`，但并非所有格式都可从 Edge 服务获取。citeturn2search0
  - 输出格式值遵循 Microsoft 语音输出格式（包括 Ogg/WebM Opus）。citeturn1search0
  - Telegram `sendVoice` 接受 OGG/MP3/M4A；如果需要有保障的 Opus 语音消息，请使用 OpenAI/ElevenLabs。citeturn1search1
  - 如果配置的 Edge 输出格式失败，OpenClaw 会以 MP3 重试。

OpenAI/ElevenLabs 格式是固定的；Telegram 需要 Opus 以获得语音消息体验。

## 自动 TTS 行为

启用后，OpenClaw：

- 如果回复已包含媒体或 `MEDIA:` 指令，则跳过 TTS。
- 跳过非常短的回复（< 10 个字符）。
- 启用时使用 `agents.defaults.model.primary`（或 `summaryModel`）对长回复进行摘要。
- 将生成的音频附加到回复中。

如果回复超过 `maxLength` 且摘要已关闭（或摘要模型没有 API 密钥），则跳过音频并发送普通文本回复。

## 流程图

```
回复 -> TTS 已启用？
  否  -> 发送文本
  是  -> 包含媒体 / MEDIA: / 过短？
          是 -> 发送文本
          否 -> 长度 > 限制？
                   否  -> TTS -> 附加音频
                   是  -> 摘要已启用？
                            否  -> 发送文本
                            是  -> 摘要（summaryModel 或 agents.defaults.model.primary）
                                      -> TTS -> 附加音频
```

## 斜杠命令用法

只有一个命令：`/tts`。
启用详情请参见[斜杠命令](/tools/slash-commands)。

Discord 说明：`/tts` 是 Discord 的内置命令，因此 OpenClaw 在该平台注册 `/voice` 作为原生命令。文本命令 `/tts ...` 仍然有效。

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

注意事项：

- 命令需要已授权的发送者（允许列表/所有者规则仍然适用）。
- 必须启用 `commands.text` 或原生命令注册。
- `off|always|inbound|tagged` 是每个会话的开关（`/tts on` 是 `/tts always` 的别名）。
- `limit` 和 `summary` 存储在本地偏好中，而非主配置中。
- `/tts audio` 生成一次性音频回复（不会切换 TTS 开关）。

## 智能体工具

`tts` 工具将文本转换为语音并返回 `MEDIA:` 路径。当结果兼容 Telegram 时，工具会包含 `[[audio_as_voice]]`，使 Telegram 发送语音气泡。

## Gateway网关 RPC

Gateway网关方法：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
