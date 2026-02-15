---
summary: "Voice Call 外掛程式：透過 Twilio/Telnyx/Plivo 進行撥出與接聽電話（外掛程式安裝 + 設定 + CLI）"
read_when:
  - 您想從 OpenClaw 撥打外部語音電話
  - 您正在設定或開發 voice-call 外掛程式
title: "Voice Call 外掛程式"
---

# Voice Call (外掛程式)

透過外掛程式為 OpenClaw 提供語音通話功能。支援撥出通知以及具備接聽原則的多輪對話。

目前的供應商：

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML 傳輸 + GetInput 語音)
- `mock` (開發用/無網路)

快速理解模型：

- 安裝外掛程式
- 重啟 Gateway
- 在 `plugins.entries.voice-call.config` 下進行設定
- 使用 `openclaw voicecall ...` 或 `voice_call` 工具

## 執行位置（地端 vs 遠端）

Voice Call 外掛程式執行於 **Gateway 程序**中。

如果您使用遠端 Gateway，請在 **執行 Gateway 的機器** 上安裝/設定外掛程式，然後重啟 Gateway 以載入它。

## 安裝

### 選項 A：從 npm 安裝（建議）

```bash
openclaw plugins install @openclaw/voice-call
```

安裝完成後請重啟 Gateway。

### 選項 B：從本機資料夾安裝（開發用途，不需複製檔案）

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

安裝完成後請重啟 Gateway。

## 設定

在 `plugins.entries.voice-call.config` 下進行設定：

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

          // Webhook 安全性（建議用於通道/代理）
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // 公開暴露方式（擇一）
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

- Twilio/Telnyx 需要一個**可從外部存取**的 Webhook URL。
- Plivo 需要一個**可從外部存取**的 Webhook URL。
- `mock` 是本機開發用的供應商（無網路呼叫）。
- `skipSignatureVerification` 僅供本機測試使用。
- 如果您使用 ngrok 免費版，請將 `publicUrl` 設定為正確的 ngrok 網址；簽章驗證一律會強制執行。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 允許 Twilio Webhook 在簽章無效的情況下通過，**僅當** `tunnel.provider="ngrok"` 且 `serve.bind` 為 local loopback (ngrok 本機代理) 時適用。僅供本機開發使用。
- Ngrok 免費版網址可能會變動或加入中間頁行為；若 `publicUrl` 跑掉，Twilio 簽章驗證將會失敗。正式環境建議使用固定網域或 Tailscale funnel。

## Webhook 安全性

當 Gateway 前方有代理或通道時，外掛程式會重建公開 URL 以進行簽章驗證。這些選項可控制哪些轉發標頭（forwarded headers）是可信的。

`webhookSecurity.allowedHosts` 會將轉發標頭中的主機加入允許清單。

`webhookSecurity.trustForwardingHeaders` 會在不使用允許清單的情況下信任轉發標頭。

`webhookSecurity.trustedProxyIPs` 僅在請求的遠端 IP 符合清單時才信任轉發標頭。

使用固定公開主機的範例：

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

## 通話專用的 TTS

Voice Call 使用核心 `messages.tts` 設定（OpenAI 或 ElevenLabs）來進行通話中的語音串流。您可以在外掛程式設定中以**相同的結構**進行覆寫 — 它會與 `messages.tts` 進行深度合併（deep-merge）。

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

- **語音通話會忽略 Edge TTS**（電話音訊需要 PCM；Edge 輸出不夠穩定）。
- 啟用 Twilio 媒體串流時會使用核心 TTS；否則通話將回退至供應商的原生語音。

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

僅針對通話覆寫為 ElevenLabs（其他地方保留核心預設值）：

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

僅針對通話覆寫 OpenAI 模型（深度合併範例）：

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

接聽原則預設為 `disabled`（停用）。要啟用接聽電話，請設定：

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

自動回覆使用智慧代理系統。可調整：

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

工具名稱：`voice_call`

動作：

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

此存放庫於 `skills/voice-call/SKILL.md` 隨附對應的 Skills 文件。

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
