---
read_when:
  - 你想从 OpenClaw 发起出站语音通话
  - 你正在配置或开发 voice-call 插件
summary: Voice Call 插件：通过 Twilio/Telnyx/Plivo 进行出站 + 入站通话（插件安装 + 配置 + CLI）
title: Voice Call 插件
x-i18n:
  generated_at: "2026-02-03T07:53:40Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d731c63bf52781cc49262db550d0507d7fc33e5e7ce5d87efaf5d44aedcafef7
  source_path: plugins/voice-call.md
  workflow: 15
---

# Voice Call（插件）

通过插件为 OpenClaw 提供语音通话。支持出站通知和带有入站策略的多轮对话。

当前提供商：

- `twilio`（Programmable Voice + Media Streams）
- `telnyx`（Call Control v2）
- `plivo`（Voice API + XML transfer + GetInput speech）
- `mock`（开发/无网络）

快速心智模型：

- 安装插件
- 重启 Gateway 网关
- 在 `plugins.entries.voice-call.config` 下配置
- 使用 `openclaw voicecall ...` 或 `voice_call` 工具

## 运行位置（本地 vs 远程）

Voice Call 插件运行在 **Gateway 网关进程内部**。

如果你使用远程 Gateway 网关，在**运行 Gateway 网关的机器**上安装/配置插件，然后重启 Gateway 网关以加载它。

## 安装

### 选项 A：从 npm 安装（推荐）

```bash
openclaw plugins install @openclaw/voice-call
```

之后重启 Gateway 网关。

### 选项 B：从本地文件夹安装（开发，不复制）

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

之后重启 Gateway 网关。

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

          // 公开暴露（选一个）
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

- Twilio/Telnyx 需要**可公开访问**的 webhook URL。
- Plivo 需要**可公开访问**的 webhook URL。
- `mock` 是本地开发提供商（无网络调用）。
- `skipSignatureVerification` 仅用于本地测试。
- 如果你使用 ngrok 免费版，将 `publicUrl` 设置为确切的 ngrok URL；签名验证始终强制执行。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 允许带有无效签名的 Twilio webhooks，**仅当** `tunnel.provider="ngrok"` 且 `serve.bind` 是 loopback（ngrok 本地代理）时。仅用于本地开发。
- Ngrok 免费版 URL 可能会更改或添加中间页面行为；如果 `publicUrl` 漂移，Twilio 签名将失败。对于生产环境，优先使用稳定域名或 Tailscale funnel。

## 通话的 TTS

Voice Call **仅**使用 `plugins.entries.voice-call.config.tts` 进行通话语音。
它**不会**读取或合并核心 `messages.tts` 配置（后者用于消息渠道的 TTS）。

示例：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "openai", // 或 "elevenlabs"
            openai: {
              voice: "alloy",
              // apiKey 可在此设置，或通过 OPENAI_API_KEY 提供
            },
          },
        },
      },
    },
  },
}
```

注意事项：

- **语音通话忽略 Edge TTS**（电话音频需要 PCM；Edge 输出不可靠）。
- 仅当启用 **Twilio 媒体流** 时才使用电话 TTS；否则通话回退到提供商原生语音。
- 若要使用 **ElevenLabs 流式**，请设置 `tts.elevenlabs.apiKey` + `tts.elevenlabs.voiceId`。（如果只设置 `ELEVENLABS_API_KEY`，插件可能回退到非流式合成。）

## 入站通话

入站策略默认为 `disabled`。要启用入站通话，设置：

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

自动响应使用智能体系统。通过以下方式调整：

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

此仓库在 `skills/voice-call/SKILL.md` 提供了配套的 skill 文档。

## Gateway 网关 RPC

- `voicecall.initiate`（`to?`、`message`、`mode?`）
- `voicecall.continue`（`callId`、`message`）
- `voicecall.speak`（`callId`、`message`）
- `voicecall.end`（`callId`）
- `voicecall.status`（`callId`）
