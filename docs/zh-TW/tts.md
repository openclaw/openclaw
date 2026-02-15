---
summary: "用於外寄回覆的文字轉語音 (TTS)"
read_when:
  - 啟用回覆的文字轉語音功能
  - 設定 TTS 供應商或限制
  - 使用 /tts 指令
title: "文字轉語音"
---

# 文字轉語音 (TTS)

OpenClaw 可以使用 ElevenLabs、OpenAI 或 Edge TTS 將外寄回覆轉換為音訊。
這適用於 OpenClaw 可以傳送音訊的任何地方；Telegram 會顯示圓形的語音訊息泡泡。

## 支援的服務

- **ElevenLabs** (主要或備用供應商)
- **OpenAI** (主要或備用供應商；也用於摘要)
- **Edge TTS** (主要或備用供應商；使用 `node-edge-tts`，在沒有 API 金鑰時為預設值)

### Edge TTS 注意事項

Edge TTS 透過 `node-edge-tts` 函式庫使用 Microsoft Edge 的線上神經 TTS 服務。
這是一項託管服務（非本地端），使用 Microsoft 的端點，且不需要 API 金鑰。`node-edge-tts` 公開了語音設定選項和輸出格式，但並非所有選項都受 Edge 服務支援。 citeturn2search0

由於 Edge TTS 是沒有發布 SLA 或配額的公共網路服務，請將其視為盡力而為 (best-effort)。如果您需要保證的限制和支援，請使用 OpenAI 或 ElevenLabs。Microsoft 的語音 REST API 文件記載了每次請求 10 分鐘的音訊限制；Edge TTS 未發布限制，因此請假設具有相似或更低的限制。 citeturn0search3

## 選用金鑰

如果您想使用 OpenAI 或 ElevenLabs：

- `ELEVENLABS_API_KEY` (或 `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **不需要** API 金鑰。如果找不到 API 金鑰，OpenClaw 預設使用 Edge TTS（除非透過 `messages.tts.edge.enabled=false` 停用）。

如果設定了多個供應商，則優先使用選定的供應商，其餘則作為備用選項。
自動摘要使用設定的 `summaryModel`（或 `agents.defaults.model.primary`），因此如果您啟用摘要，該供應商也必須通過身份驗證。

## 服務連結

- [OpenAI 文字轉語音指南](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API 參考](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 文字轉語音](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 身份驗證](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft 語音輸出格式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 預設是否啟用？

否。自動 TTS 預設為**關閉**。請在設定中使用 `messages.tts.auto` 啟用，或在每個工作階段中使用 `/tts always`（別名：`/tts on`）啟用。

一旦 TTS 開啟，Edge TTS 預設即為**啟用**，且在沒有 OpenAI 或 ElevenLabs API 金鑰可用時會自動使用。

## 設定

TTS 設定位於 `openclaw.json` 中的 `messages.tts` 下。
完整的架構請見 [Gateway 設定](/gateway/configuration)。

### 基本設定 (啟用 + 供應商)

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

### 以 OpenAI 為主，ElevenLabs 為備用

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

### 以 Edge TTS 為主 (無 API 金鑰)

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

### 自定義限制 + 偏好設定路徑

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

### 僅在收到語音訊息後才以音訊回覆

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

然後執行：

```
/tts summary off
```

### 欄位說明

- `auto`：自動 TTS 模式 (`off`, `always`, `inbound`, `tagged`)。
  - `inbound` 僅在收到語音訊息後才傳送音訊。
  - `tagged` 僅在回覆包含 `[[tts]]` 標籤時才傳送音訊。
- `enabled`：舊版開關 (doctor 會將其遷移至 `auto`)。
- `mode`：`"final"` (預設) 或 `"all"` (包含工具/區塊回覆)。
- `provider`：`"elevenlabs"`、`"openai"` 或 `"edge"`（會自動備援）。
- 如果 `provider` **未設定**，OpenClaw 會優先選用 `openai`（如果有金鑰），接著是 `elevenlabs`（如果有金鑰），否則使用 `edge`。
- `summaryModel`：用於自動摘要的選用廉價模型；預設為 `agents.defaults.model.primary`。
  - 接受 `provider/model` 或已設定的模型別名。
- `modelOverrides`：允許模型發出 TTS 指令（預設為開啟）。
- `maxTextLength`：TTS 輸入的硬性限制（字元數）。如果超過，`/tts audio` 將失敗。
- `timeoutMs`：請求逾時 (ms)。
- `prefsPath`：覆寫本地偏好設定 JSON 路徑 (provider/limit/summary)。
- `apiKey` 的值會回退到環境變數 (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`)。
- `elevenlabs.baseUrl`：覆寫 ElevenLabs API 基礎 URL。
- `elevenlabs.voiceSettings`：
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = 正常)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2 位字母的 ISO 639-1 (例如 `en`, `de`)
- `elevenlabs.seed`: 整數 `0..4294967295` (盡力而為的確定性)
- `edge.enabled`：允許使用 Edge TTS（預設為 `true`；無須 API 金鑰）。
- `edge.voice`：Edge 神經語音名稱 (例如 `en-US-MichelleNeural`)。
- `edge.lang`：語言代碼 (例如 `en-US`)。
- `edge.outputFormat`：Edge 輸出格式 (例如 `audio-24khz-48kbitrate-mono-mp3`)。
  - 有效值請參閱 Microsoft 語音輸出格式；並非所有格式都受 Edge 支援。
- `edge.rate` / `edge.pitch` / `edge.volume`：百分比字串 (例如 `+10%`, `-5%`)。
- `edge.saveSubtitles`：在音訊檔案旁寫入 JSON 字幕。
- `edge.proxy`：Edge TTS 請求的代理伺服器 URL。
- `edge.timeoutMs`：覆寫請求逾時 (ms)。

## 模型驅動的覆寫 (預設為開啟)

預設情況下，模型**可以**針對單次回覆發出 TTS 指令。
當 `messages.tts.auto` 為 `tagged` 時，需要這些指令才能觸發音訊。

啟用後，模型可以發出 `[[tts:...]]` 指令以覆寫單次回覆的語音，外加選用的 `[[tts:text]]...[[/tts:text]]` 區塊，以提供僅應出現在音訊中的表現力標籤（笑聲、唱歌提示等）。

回覆內容範例：

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

可用的指令鍵名（啟用時）：

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI 語音) 或 `voiceId` (ElevenLabs)
- `model` (OpenAI TTS 模型或 ElevenLabs 模型 ID)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
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

選用允許可清單（在保持標籤啟用的同時停用特定覆寫）：

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

## 每位使用者的偏好設定

斜線指令會將本地覆寫寫入至 `prefsPath`（預設：`~/.openclaw/settings/tts.json`，可使用 `OPENCLAW_TTS_PREFS` 或 `messages.tts.prefsPath` 覆寫）。

儲存的欄位：

- `enabled`
- `provider`
- `maxLength` (摘要門檻；預設為 1500 字元)
- `summarize` (預設為 `true`)

這些設定會為該主機覆寫 `messages.tts.*`。

## 輸出格式 (固定)

- **Telegram**：Opus 語音訊息 (ElevenLabs 為 `opus_48000_64`，OpenAI 為 `opus`)。
  - 48kHz / 64kbps 是語音訊息的一個很好的平衡點，也是圓形泡泡所要求的。
- **其他頻道**：MP3 (ElevenLabs 為 `mp3_44100_128`，OpenAI 為 `mp3`)。
  - 44.1kHz / 128kbps 是語音清晰度的預設平衡點。
- **Edge TTS**：使用 `edge.outputFormat`（預設為 `audio-24khz-48kbitrate-mono-mp3`）。
  - `node-edge-tts` 接受 `outputFormat`，但並非所有格式都可從 Edge 服務獲得。 citeturn2search0
  - 輸出格式值遵循 Microsoft 語音輸出格式（包括 Ogg/WebM Opus）。 citeturn1search0
  - Telegram `sendVoice` 接受 OGG/MP3/M4A；如果您需要保證的 Opus 語音訊息，請使用 OpenAI/ElevenLabs。 citeturn1search1
  - 如果設定的 Edge 輸出格式失敗，OpenClaw 會使用 MP3 重試。

OpenAI/ElevenLabs 的格式是固定的；Telegram 要求使用 Opus 以提供語音訊息的用戶體驗 (UX)。

## 自動 TTS 行為

啟用後，OpenClaw 會：

- 如果回覆已包含媒體或 `MEDIA:` 指令，則跳過 TTS。
- 跳過極短的回覆（< 10 字元）。
- 啟用時，使用 `agents.defaults.model.primary`（或 `summaryModel`）對長回覆進行摘要。
- 將生成的音訊附加到回覆中。

如果回覆超過 `maxLength` 且摘要功能關閉（或摘要模型沒有 API 金鑰），則跳過音訊並傳送一般的文字回覆。

## 流程圖

```
回覆 -> 已啟用 TTS？
  否  -> 傳送文字
  是 -> 具有媒體 / MEDIA: / 過短？
          是 -> 傳送文字
          否  -> 長度 > 限制？
                   否  -> TTS -> 附加音訊
                   是 -> 已啟用摘要？
                            否  -> 傳送文字
                            是 -> 進行摘要 (summaryModel 或 agents.defaults.model.primary)
                                      -> TTS -> 附加音訊
```

## 斜線指令用法

只有一個指令：`/tts`。
有關啟用詳情，請參閱[斜線指令](/tools/slash-commands)。

Discord 說明：`/tts` 是 Discord 內建指令，因此 OpenClaw 在該處註冊 `/voice` 作為原生指令。文字輸入 `/tts ...` 仍然有效。

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

說明：

- 指令需要獲得授權的傳送者（允許清單/所有者規則仍然適用）。
- 必須啟用 `commands.text` 或原生指令註冊。
- `off|always|inbound|tagged` 是針對每個工作階段的切換開關（`/tts on` 是 `/tts always` 的別名）。
- `limit` 和 `summary` 儲存在本地偏好設定中，而非主設定檔。
- `/tts audio` 會生成一次性的音訊回覆（不會開啟 TTS）。

## 智慧代理工具

`tts` 工具將文字轉換為語音並傳回 `MEDIA:` 路徑。當結果與 Telegram 相容時，工具會包含 `[[audio_as_voice]]`，以便 Telegram 傳送語音泡泡。

## Gateway RPC

Gateway 方法：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
