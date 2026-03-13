---
summary: >-
  Voice Call plugin: outbound + inbound calls via Twilio/Telnyx/Plivo (plugin
  install + config + CLI)
read_when:
  - You want to place an outbound voice call from OpenClaw
  - You are configuring or developing the voice-call plugin
title: Voice Call Plugin
---

# 語音通話（插件）

OpenClaw 的語音通話功能透過插件實現。支援外撥通知及帶有進入政策的多輪對話。

目前支援的服務提供者：

- `twilio`（可程式化語音 + 媒體串流）
- `telnyx`（通話控制 v2）
- `plivo`（語音 API + XML 傳輸 + GetInput 語音）
- `mock`（開發用／無網路）

快速心智模型：

- 安裝插件
- 重新啟動 Gateway
- 在 `plugins.entries.voice-call.config` 下進行設定
- 使用 `openclaw voicecall ...` 或 `voice_call` 工具

## 執行位置（本地 vs 遠端）

語音通話插件執行於 **Gateway 程式內**。

若使用遠端 Gateway，請在 **執行 Gateway 的機器上安裝/設定插件**，然後重新啟動 Gateway 以載入插件。

## 安裝

### 選項 A：從 npm 安裝（推薦）

```bash
openclaw plugins install @openclaw/voice-call
```

安裝完成後請重新啟動 Gateway。

### 選項 B：從本地資料夾安裝（開發用，無需複製）

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

之後重新啟動 Gateway。

## 設定

在 `plugins.entries.voice-call.config` 下設定設定：

json5
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

telnyx: {
apiKey: "...",
connectionId: "...",
// Telnyx webhook 公鑰，來自 Telnyx Mission Control Portal
// （Base64 字串；也可透過 TELNYX_PUBLIC_KEY 設定）。
publicKey: "...",
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

// Webhook 安全性（建議用於隧道/代理）
webhookSecurity: {
allowedHosts: ["voice.example.com"],
trustedProxyIPs: ["100.64.0.1"],
},

// 公開暴露（擇一）
// publicUrl: "https://example.ngrok.app/voice/webhook",
// tunnel: { provider: "ngrok" },
// tailscale: { mode: "funnel", path: "/voice/webhook" }

outbound: {
defaultMode: "notify", // notify | conversation
},

streaming: {
enabled: true,
streamPath: "/voice/stream",
preStartTimeoutMs: 5000,
maxPendingConnections: 32,
maxPendingConnectionsPerIp: 4,
maxConnections: 128,
},
},
},
},
},
}

注意事項：

- Twilio/Telnyx 需要一個**公開可訪問**的 webhook URL。
- Plivo 需要一個**公開可訪問**的 webhook URL。
- `mock` 是本地開發提供者（不會有網路呼叫）。
- Telnyx 需要 `telnyx.publicKey`（或 `TELNYX_PUBLIC_KEY`），除非 `skipSignatureVerification` 為 true。
- `skipSignatureVerification` 僅用於本地測試。
- 如果使用 ngrok 免費方案，請將 `publicUrl` 設為精確的 ngrok URL；簽名驗證始終會被強制執行。
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` 允許 Twilio webhook 在 `tunnel.provider="ngrok"` 和 `serve.bind` 為 loopback（ngrok 本地代理）時，接受無效簽名。僅用於本地開發。
- Ngrok 免費方案的 URL 可能會變動或加入中介行為；若 `publicUrl` 變動，Twilio 簽名將會失敗。生產環境建議使用穩定網域或 Tailscale funnel。
- 串流安全預設：
  - `streaming.preStartTimeoutMs` 會關閉從未送出有效 `start` 框架的 socket。
  - `streaming.maxPendingConnections` 限制未驗證的 pre-start socket 總數。
  - `streaming.maxPendingConnectionsPerIp` 限制每個來源 IP 的未驗證 pre-start socket 數量。
  - `streaming.maxConnections` 限制總開啟的媒體串流 socket（包含待處理與活動中）。

## 過期通話清理器

使用 `staleCallReaperSeconds` 來結束那些從未收到終端 webhook 的通話  
（例如，從未完成的通知模式通話）。預設值為 `0`（停用）。

建議範圍：

- **正式環境：** 通知式流程建議設定為 `120`–`300` 秒。
- 請保持此值 **高於 `maxDurationSeconds`**，以便正常通話能夠完成。  
  一個不錯的起始點是 `maxDurationSeconds + 30–60` 秒。

範例：

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          maxDurationSeconds: 300,
          staleCallReaperSeconds: 360,
        },
      },
    },
  },
}
```

## Webhook 安全性

當代理或隧道位於 Gateway 前端時，插件會重建公開 URL 以進行簽名驗證。  
這些選項用來控制哪些轉發標頭是被信任的。

`webhookSecurity.allowedHosts` 從轉發標頭中允許特定主機。

`webhookSecurity.trustForwardingHeaders` 在沒有允許清單的情況下信任轉發標頭。

`webhookSecurity.trustedProxyIPs` 僅在請求的遠端 IP 符合清單時，才信任轉發標頭。

Webhook 重放保護已針對 Twilio 和 Plivo 啟用。  
重放的有效 webhook 請求會被確認，但會跳過副作用執行。

Twilio 會話回合在 `<Gather>` 回調中包含每回合的 token，  
因此過期或重放的語音回調無法滿足較新的待處理轉錄回合。

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

Voice Call 使用核心 `messages.tts` 設定（OpenAI 或 ElevenLabs）來進行通話中的語音串流。你可以在插件設定中以 **相同結構** 覆寫它 — 它會與 `messages.tts` 進行深度合併。

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

- **Edge TTS 在語音通話中會被忽略**（電話音訊需要 PCM；Edge 輸出不穩定）。
- 啟用 Twilio 媒體串流時會使用核心 TTS；否則通話會回退到供應商的原生語音。

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

僅在通話中覆寫為 ElevenLabs（其他地方保留核心預設）：

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

僅在通話中覆寫 OpenAI 模型（深度合併範例）：

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

來電策略預設為 `disabled`。要啟用來電，請設定：

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

自動回應使用代理系統。可透過以下方式調整：

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

## 代理工具

工具名稱：`voice_call`

操作：

- `initiate_call` (訊息, 發送給?, 模式?)
- `continue_call` (callId, 訊息)
- `speak_to_user` (callId, 訊息)
- `end_call` (callId)
- `get_status` (callId)

此倉庫附帶一份對應的技能文件，位於 `skills/voice-call/SKILL.md`。

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
