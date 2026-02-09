---
summary: "語音通話外掛：透過 Twilio／Telnyx／Plivo 進行撥出與來電（外掛安裝＋設定＋ CLI）"
read_when:
  - 你想要從 OpenClaw 撥出語音通話
  - 你正在設定或開發語音通話外掛
title: "plugins/voice-call.md"
---

# 語音通話（外掛）

透過外掛為 OpenClaw 提供語音通話。支援撥出通知，以及具備來電政策的多輪對話。 Supports outbound notifications and
multi-turn conversations with inbound policies.

目前的提供者：

- `twilio`（Programmable Voice＋Media Streams）
- `telnyx`（Call Control v2）
- `plivo`（Voice API＋XML transfer＋GetInput speech）
- `mock`（dev／無網路）

快速心智模型：

- Install plugin
- 重新啟動 Gateway
- 在 `plugins.entries.voice-call.config` 底下設定
- 使用 `openclaw voicecall ...` 或 `voice_call` 工具

## 執行位置（本機 vs 遠端）

語音通話外掛**在 Gateway 程序內執行**。

If you use a remote Gateway, install/configure the plugin on the **machine running the Gateway**, then restart the Gateway to load it.

## 安裝

### 選項 A：從 npm 安裝（建議）

```bash
openclaw plugins install @openclaw/voice-call
```

之後重新啟動 Gateway。

### 選項 B：從本機資料夾安裝（dev，不複製）

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

之後重新啟動 Gateway。

## 設定

在 `plugins.entries.voice-call.config` 底下設定：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
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

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
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

注意事項：

- Twilio／Telnyx 需要**可公開存取**的 webhook URL。
- Plivo 需要**可公開存取**的 webhook URL。
- `mock` 是本機開發用的提供者（無網路呼叫）。
- `skipSignatureVerification` 僅用於本機測試。
- 若你使用 ngrok 免費方案，請將 `publicUrl` 設為精確的 ngrok URL；簽章驗證一律會強制執行。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 只在 `tunnel.provider="ngrok"` 且 `serve.bind` 為 loopback（ngrok 本機代理）時，允許簽章無效的 Twilio webhook。僅供本機開發使用。 僅供本機開發使用。
- Ngrok 免費方案的 URL 可能變更或加入插頁行為；若 `publicUrl` 發生偏移，Twilio 簽章將會失敗。正式環境請優先使用穩定網域或 Tailscale funnel。 For production, prefer a stable domain or Tailscale funnel.

## Webhook 安全性

當 Gateway 前方有代理或通道時，外掛會重建公開 URL 以進行簽章驗證。 These options control which forwarded
headers are trusted.

`webhookSecurity.allowedHosts` 會對轉送標頭中的主機進行允許清單。

`webhookSecurity.trustForwardingHeaders` 在沒有允許清單的情況下信任轉送標頭。

`webhookSecurity.trustedProxyIPs` only trusts forwarded headers when the request
remote IP matches the list.

使用穩定公開主機的範例：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## 通話的 TTS

語音通話會使用核心的 `messages.tts` 設定（OpenAI 或 ElevenLabs）在通話中進行串流語音。你可以在外掛設定中以**相同結構**覆寫；它會與 `messages.tts` 進行深度合併。 你可以在外掛設定底下以
**相同結構** 覆寫它——它會與 `messages.tts` 進行深度合併。

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

注意事項：

- **語音通話會忽略 Edge TTS**（電信音訊需要 PCM；Edge 輸出不可靠）。
- 啟用 Twilio 媒體串流時會使用核心 TTS；否則通話會回退至提供者原生語音。

### 更多範例

僅使用核心 TTS（不覆寫）：

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

只針對通話覆寫為 ElevenLabs（其他地方維持核心預設）：

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

僅覆寫通話用的 OpenAI 模型（深度合併範例）：

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

## 來電

入站政策預設為 `disabled`。 要啟用入站呼叫，請設定：

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Auto-responses use the agent system. Tune with:

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

## 代理程式工具

工具名稱：`voice_call`

動作：

- `initiate_call`（message、to?、mode?）
- `continue_call`（callId、message）
- `speak_to_user`（callId、message）
- `end_call`（callId）
- `get_status`（callId）

此儲存庫在 `skills/voice-call/SKILL.md` 提供對應的 Skill 文件。

## Gateway RPC

- `voicecall.initiate`（`to?`、`message`、`mode?`）
- `voicecall.continue`（`callId`、`message`）
- `voicecall.speak`（`callId`、`message`）
- `voicecall.end`（`callId`）
- `voicecall.status`（`callId`）
