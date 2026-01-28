---
read_when:
  - 你想通过 OpenClaw 发起外呼语音通话
  - 你正在配置或开发语音通话插件
summary: 语音通话插件：通过 Twilio/Telnyx/Plivo 进行外呼和来电（插件安装 + 配置 + CLI）
title: 语音通话插件
x-i18n:
  generated_at: "2026-02-01T21:34:37Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d731c63bf52781cc49262db550d0507d7fc33e5e7ce5d87efaf5d44aedcafef7
  source_path: plugins/voice-call.md
  workflow: 15
---

# 语音通话（插件）

通过插件为 OpenClaw 提供语音通话功能。支持外呼通知和多轮对话的来电策略。

当前支持的提供商：

- `twilio`（Programmable Voice + Media Streams）
- `telnyx`（Call Control v2）
- `plivo`（Voice API + XML transfer + GetInput speech）
- `mock`（开发环境/无网络）

快速理解模型：

- 安装插件
- 重启 Gateway网关
- 在 `plugins.entries.voice-call.config` 下进行配置
- 使用 `openclaw voicecall ...` 或 `voice_call` 工具

## 运行位置（本地 vs 远程）

语音通话插件运行在 **Gateway网关进程内部**。

如果你使用远程 Gateway网关，请在**运行 Gateway网关的机器**上安装和配置插件，然后重启 Gateway网关以加载它。

## 安装

### 方式 A：从 npm 安装（推荐）

```bash
openclaw plugins install @openclaw/voice-call
```

安装后重启 Gateway网关。

### 方式 B：从本地文件夹安装（开发环境，不复制文件）

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

安装后重启 Gateway网关。

## 配置

在 `plugins.entries.voice-call.config` 下设置配置：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // 或 "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook 服务器
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // 公网暴露（选择其一）
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

注意事项：

- Twilio/Telnyx 需要一个**可公网访问的** webhook URL。
- Plivo 需要一个**可公网访问的** webhook URL。
- `mock` 是本地开发提供商（不进行网络调用）。
- `skipSignatureVerification` 仅用于本地测试。
- 如果你使用 ngrok 免费版，请将 `publicUrl` 设置为精确的 ngrok URL；签名验证始终强制执行。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 允许在 `tunnel.provider="ngrok"` 且 `serve.bind` 为 local loopback（ngrok 本地代理）时，接受签名无效的 Twilio webhook。**仅用于本地开发**。
- Ngrok 免费版 URL 可能会变化或出现插页行为；如果 `publicUrl` 偏移，Twilio 签名将会失败。生产环境建议使用稳定域名或 Tailscale funnel。

## 通话的 TTS

语音通话使用核心 `messages.tts` 配置（OpenAI 或 ElevenLabs）来进行通话中的流式语音合成。你可以在插件配置下使用**相同的结构**进行覆盖——它会与 `messages.tts` 进行深度合并。

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

注意事项：

- **语音通话会忽略 Edge TTS**（电话音频需要 PCM；Edge 输出不可靠）。
- 当启用 Twilio 媒体流时使用核心 TTS；否则通话将回退到提供商原生语音。

### 更多示例

仅使用核心 TTS（不覆盖）：

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

仅为通话覆盖为 ElevenLabs（其他地方保持核心默认值）：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

仅为通话覆盖 OpenAI 模型（深度合并示例）：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## 来电

来电策略默认为 `disabled`。要启用来电，请设置：

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

自动回复使用智能体系统。通过以下参数进行调优：

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## 智能体工具

工具名称：`voice_call`

操作：

- `initiate_call`（message、to?、mode?）
- `continue_call`（callId、message）
- `speak_to_user`（callId、message）
- `end_call`（callId）
- `get_status`（callId）

本仓库附带了对应的 Skills 文档，位于 `skills/voice-call/SKILL.md`。

## Gateway网关 RPC

- `voicecall.initiate`（`to?`、`message`、`mode?`）
- `voicecall.continue`（`callId`、`message`）
- `voicecall.speak`（`callId`、`message`）
- `voicecall.end`（`callId`）
- `voicecall.status`（`callId`）
