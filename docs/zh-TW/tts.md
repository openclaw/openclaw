---
summary: Text-to-speech (TTS) for outbound replies
read_when:
  - Enabling text-to-speech for replies
  - Configuring TTS providers or limits
  - Using /tts commands
title: Text-to-Speech
---

# 文字轉語音 (TTS)

OpenClaw 可以使用 ElevenLabs、OpenAI 或 Edge TTS 將外發回覆轉換成語音。
只要 OpenClaw 能發送音訊的地方都適用；Telegram 則會顯示圓形語音訊息氣泡。

## 支援的服務

- **ElevenLabs**（主要或備用提供者）
- **OpenAI**（主要或備用提供者；也用於摘要）
- **Edge TTS**（主要或備用提供者；使用 `node-edge-tts`，無 API 金鑰時預設）

### Edge TTS 注意事項

Edge TTS 透過 `node-edge-tts` 函式庫使用 Microsoft Edge 線上神經語音服務。這是託管服務（非本地端），使用微軟的端點，且不需要 API 金鑰。`node-edge-tts` 提供語音設定選項和輸出格式，但並非所有選項都被 Edge 服務支援。citeturn2search0

由於 Edge TTS 是公開的網路服務，且沒有公開的服務等級協議（SLA）或配額限制，請視為盡力而為的服務。如果需要有保證的限制和支援，請使用 OpenAI 或 ElevenLabs。
微軟的 Speech REST API 文件中，每次請求限制 10 分鐘音訊；Edge TTS 未公布限制，請假設限制相似或更低。citeturn0search3

## 選用金鑰

如果你想使用 OpenAI 或 ElevenLabs：

- `ELEVENLABS_API_KEY`（或 `XI_API_KEY`）
- `OPENAI_API_KEY`

Edge TTS **不需要** API 金鑰。如果找不到 API 金鑰，OpenClaw 預設使用 Edge TTS（除非透過 `messages.tts.edge.enabled=false` 禁用）。

如果設定多個提供者，會先使用所選提供者，其他則作為備用。
自動摘要會使用設定的 `summaryModel`（或 `agents.defaults.model.primary`），
因此啟用摘要時該提供者也必須通過認證。

## 服務連結

- [OpenAI 文字轉語音指南](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI 音訊 API 參考](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 文字轉語音](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 認證](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft 語音輸出格式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 預設是否啟用？

不。Auto‑TTS 預設是**關閉**的。可在設定中使用 `messages.tts.auto` 啟用，或在每次會話中使用 `/tts always`（別名：`/tts on`）啟用。

Edge TTS 在開啟 TTS 後預設**啟用**，當沒有 OpenAI 或 ElevenLabs API 金鑰時會自動使用。

## 設定

TTS 設定位於 `messages.tts` 的 `openclaw.json` 下。
完整架構請參考 [Gateway configuration](/gateway/configuration)。

### 最小設定（啟用 + 服務提供者）

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

### 以 OpenAI 為主，ElevenLabs 為備援

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
}
```

### 以 Edge TTS 為主（無需 API 金鑰）

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

### 停用 Edge TTS

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

### 自訂限制 + 偏好設定路徑

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

### 僅在收到語音訊息後回覆音訊

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### 停用長回覆的自動摘要

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

接著執行：

```
/tts summary off
```

### 欄位說明

- `auto`：自動 TTS 模式（`off`、`always`、`inbound`、`tagged`）。
  - `inbound` 僅在收到語音訊息後才傳送音訊。
  - `tagged` 僅在回覆包含 `[[tts]]` 標籤時傳送音訊。
- `enabled`：舊版切換（醫生會將此遷移至 `auto`）。
- `mode`：`"final"`（預設）或 `"all"`（包含工具/區塊回覆）。
- `provider`：`"elevenlabs"`、`"openai"` 或 `"edge"`（備援為自動）。
- 若 `provider` **未設定**，OpenClaw 優先使用 `openai`（若有金鑰），接著是 `elevenlabs`（若有金鑰），否則使用 `edge`。
- `summaryModel`：自動摘要的可選廉價模型；預設為 `agents.defaults.model.primary`。
  - 可接受 `provider/model` 或已設定的模型別名。
- `modelOverrides`：允許模型輸出 TTS 指令（預設開啟）。
  - `allowProvider` 預設為 `false`（提供者切換為選用）。
- `maxTextLength`：TTS 輸入字元數上限。超過 `/tts audio` 會失敗。
- `timeoutMs`：請求逾時時間（毫秒）。
- `prefsPath`：覆寫本地偏好設定 JSON 路徑（提供者/限制/摘要）。
- `apiKey` 的值會回退至環境變數（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）。
- `elevenlabs.baseUrl`：覆寫 ElevenLabs API 基底 URL。
- `openai.baseUrl`：覆寫 OpenAI TTS 端點。
  - 解決順序：`messages.tts.openai.baseUrl` -> `OPENAI_TTS_BASE_URL` -> `https://api.openai.com/v1`
  - 非預設值視為相容 OpenAI 的 TTS 端點，因此接受自訂模型與語音名稱。
- `elevenlabs.voiceSettings`：
  - `stability`、`similarityBoost`、`style`：`0..1`
  - `useSpeakerBoost`：`true|false`
  - `speed`：`0.5..2.0`（1.0 = 正常）
- `elevenlabs.applyTextNormalization`：`auto|on|off`
- `elevenlabs.languageCode`：2 字母 ISO 639-1 語言程式碼（例如 `en`、`de`）
- `elevenlabs.seed`：整數 `0..4294967295`（盡力而為的確定性）
- `edge.enabled`：允許使用 Edge TTS（預設 `true`；無需 API 金鑰）。
- `edge.voice`：Edge 神經語音名稱（例如 `en-US-MichelleNeural`）。
- `edge.lang`：語言程式碼（例如 `en-US`）。
- `edge.outputFormat`：Edge 輸出格式（例如 `audio-24khz-48kbitrate-mono-mp3`）。
  - 請參考 Microsoft Speech 輸出格式以取得有效值；並非所有格式 Edge 都支援。
- `edge.rate` / `edge.pitch` / `edge.volume`：百分比字串（例如 `+10%`、`-5%`）。
- `edge.saveSubtitles`：在音訊檔旁寫入 JSON 字幕。
- `edge.proxy`：Edge TTS 請求的代理伺服器 URL。
- `edge.timeoutMs`：請求逾時覆寫（毫秒）。

## 模型驅動的覆寫（預設開啟）

預設情況下，模型**可以**為單次回覆輸出 TTS 指令。
當 `messages.tts.auto` 為 `tagged` 時，必須有這些指令才能觸發音訊。

啟用後，模型可以輸出 `[[tts:...]]` 指令來覆寫單次回覆的語音，
並可選擇附加 `[[tts:text]]...[[/tts:text]]` 區塊，
提供只會出現在音訊中的表情標籤（如笑聲、唱歌提示等）。

除非 `modelOverrides.allowProvider: true`，否則會忽略 `provider=...` 指令。

範例回覆內容：

給你。

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](笑) 再讀一次這首歌。[[/tts:text]]

可用的指令鍵（啟用時）：

- `provider` (`openai` | `elevenlabs` | `edge`，需要 `allowProvider: true`)
- `voice`（OpenAI 語音）或 `voiceId`（ElevenLabs）
- `model`（OpenAI TTS 模型或 ElevenLabs 模型 ID）
- `stability`、`similarityBoost`、`style`、`speed`、`useSpeakerBoost`
- `applyTextNormalization`（`auto|on|off`）
- `languageCode`（ISO 639-1）
- `seed`

停用所有模型覆寫：

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

選用白名單（啟用供應商切換，同時保持其他設定可調整）：

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

## 每用戶偏好設定

斜線指令會將本地覆寫寫入 `prefsPath`（預設為 `~/.openclaw/settings/tts.json`，可用 `OPENCLAW_TTS_PREFS` 或 `messages.tts.prefsPath` 覆寫）。

儲存欄位：

- `enabled`
- `provider`
- `maxLength`（摘要門檻；預設 1500 字元）
- `summarize`（預設 `true`）

這些會覆寫該主機的 `messages.tts.*`。

## 輸出格式（固定）

- **Telegram**：Opus 語音訊息（`opus_48000_64` 來自 ElevenLabs，`opus` 來自 OpenAI）。
  - 48kHz / 64kbps 是語音訊息的良好折衷，且為圓形氣泡所需。
- **其他頻道**：MP3（`mp3_44100_128` 來自 ElevenLabs，`mp3` 來自 OpenAI）。
  - 44.1kHz / 128kbps 是語音清晰度的預設平衡。
- **Edge TTS**：使用 `edge.outputFormat`（預設 `audio-24khz-48kbitrate-mono-mp3`）。
  - `node-edge-tts` 接受 `outputFormat`，但並非所有格式都可由 Edge 服務提供。citeturn2search0
  - 輸出格式值遵循 Microsoft Speech 輸出格式（包含 Ogg/WebM Opus）。citeturn1search0
  - Telegram `sendVoice` 支援 OGG/MP3/M4A；若需要保證 Opus 語音訊息，請使用 OpenAI/ElevenLabs。citeturn1search1
  - 若設定的 Edge 輸出格式失敗，OpenClaw 會改用 MP3 重試。

OpenAI/ElevenLabs 格式為固定；Telegram 預期使用 Opus 以符合語音訊息使用者體驗。

## 自動 TTS 行為

啟用時，OpenClaw：

- 如果回覆已包含媒體或 `MEDIA:` 指令，則跳過 TTS。
- 跳過非常短的回覆（少於 10 個字元）。
- 啟用時，使用 `agents.defaults.model.primary`（或 `summaryModel`）對長回覆進行摘要。
- 將產生的音訊附加到回覆中。

如果回覆超過 `maxLength` 且摘要功能關閉（或沒有摘要模型的 API 金鑰），則跳過音訊，僅傳送一般文字回覆。

## 流程圖

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## 斜線指令用法

只有一個指令：`/tts`。
詳細啟用方式請參考 [斜線指令](/tools/slash-commands)。

Discord 注意事項：`/tts` 是 Discord 內建指令，因此 OpenClaw 在那裡註冊 `/voice` 作為原生指令。文字指令 `/tts ...` 仍可使用。

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

注意事項：

- 指令需由授權發送者執行（允許清單/擁有者規則仍適用）。
- 必須啟用 `commands.text` 或原生指令註冊。
- `off|always|inbound|tagged` 是每次會話的切換開關（`/tts on` 是 `/tts always` 的別名）。
- `limit` 和 `summary` 儲存在本地偏好設定，不在主設定檔中。
- `/tts audio` 會產生一次性音訊回覆（不會切換 TTS 開啟）。

## 代理工具

`tts` 工具將文字轉為語音並回傳 `MEDIA:` 路徑。當結果相容於 Telegram 時，工具會包含 `[[audio_as_voice]]`，讓 Telegram 傳送語音氣泡。

## Gateway RPC

Gateway 方法：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
