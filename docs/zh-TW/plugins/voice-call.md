---
summary: "語音通話外掛：透過 Twilio/Telnyx/Plivo 進行撥出 + 接聽電話（外掛安裝 + 設定 + CLI）"
read_when:
  - 您想從 OpenClaw 撥出語音電話時
  - 您正在設定或開發語音通話外掛時
title: "語音通話外掛"
---

# 語音通話 (外掛)

透過外掛在 OpenClaw 中進行語音通話。支援撥出通知和
具備接聽策略的多輪對話。

目前的供應商：

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/no network)

快速心智模型：

- 安裝外掛
- 重新啟動 Gateway
- 在 `plugins.entries.voice-call.config` 下進行設定
- 使用 `openclaw voicecall ...` 或 `voice_call` 工具

## 執行位置 (本機與遠端)

語音通話外掛在 **Gateway 程式** 內部執行。

如果您使用遠端 Gateway，請在**執行 Gateway 的機器**上安裝/設定外掛，然後重新啟動 Gateway 以載入它。

## 安裝

### 選項 A: 從 npm 安裝 (推薦)

```bash
openclaw plugins install @openclaw/voice-call
```

之後重新啟動 Gateway。

### 選項 B: 從本機資料夾安裝 (開發用，不複製)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

之後重新啟動 Gateway。

## 設定

在 `plugins.entries.voice-call.config` 下設定：

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

          // Webhook 伺服器
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook 安全性 (推薦用於通道/代理)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // 公開暴露 (擇一)
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

- Twilio/Telnyx 需要一個**可公開存取**的 webhook URL。
- Plivo 需要一個**可公開存取**的 webhook URL。
- `mock` 是一個本機開發供應商 (無網路呼叫)。
- `skipSignatureVerification` 僅供本機測試使用。
- 如果您使用 ngrok 免費方案，請將 `publicUrl` 設定為確切的 ngrok URL；簽章驗證始終強制執行。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 僅在 `tunnel.provider="ngrok"` 且 `serve.bind` 為 local loopback (ngrok 本機代理) 時，允許 Twilio webhooks 帶有無效簽章。僅供本機開發使用。
- Ngrok 免費方案的 URL 可能會變更或增加插頁式行為；如果 `publicUrl` 漂移，Twilio 簽章將會失敗。對於生產環境，請優先選擇穩定的網域或 Tailscale funnel。

## Webhook 安全性

當代理或通道位於 Gateway 前方時，外掛會重新建構
用於簽章驗證的公開 URL。這些選項控制哪些轉發的
標頭是受信任的。

`webhookSecurity.allowedHosts` 允許來自轉發標頭的主機。

`webhookSecurity.trustForwardingHeaders` 信任轉發標頭，無需允許清單。

`webhookSecurity.trustedProxyIPs` 僅在請求的
遠端 IP 與清單匹配時才信任轉發標頭。

穩定公開主機的範例：

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

## 通話語音合成 (TTS)

語音通話使用核心 `messages.tts` 設定 (OpenAI 或 ElevenLabs) 來
在通話中串流語音。您可以在外掛設定中以**相同格式**覆寫它
— 它會與 `messages.tts` 進行深度合併。

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

- **Edge TTS 會被語音通話忽略** (電話音訊需要 PCM；Edge 輸出不可靠)。
- 當啟用 Twilio 媒體串流時，會使用核心 TTS；否則通話會退回到供應商的原生語音。

### 更多範例

僅使用核心 TTS (不覆寫)：

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

僅針對通話覆寫為 ElevenLabs (其他地方保留核心預設)：

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

僅針對通話覆寫 OpenAI 模型 (深度合併範例)：

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

## 接聽電話

接聽策略預設為 `disabled`。若要啟用接聽電話，請設定：

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

自動回應使用智慧代理系統。可透過以下項目調整：

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

## 智慧代理工具

工具名稱: `voice_call`

動作：

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

此儲存庫隨附一個匹配的技能檔案，位於 `skills/voice-call/SKILL.md`。

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
