```
---
summary: "用於外發回覆的語音合成 (TTS)"
read_when:
  - 啟用回覆的語音合成
  - 設定 TTS 供應商或限制
  - 使用 /tts 指令
title: "語音合成"
---

# 語音合成 (TTS)

OpenClaw 可以使用 ElevenLabs、OpenAI 或 Edge TTS 將外發回覆轉換為音訊。
它適用於 OpenClaw 可以傳送音訊的任何地方；Telegram 會顯示一個圓形語音備忘錄氣泡。

## 支援的服務

- **ElevenLabs** (主要或備援供應商)
- **OpenAI** (主要或備援供應商；也用於摘要)
- **Edge TTS** (主要或備援供應商；使用 `node-edge-tts`，若無 API 密鑰則為預設)

### Edge TTS 說明

Edge TTS 透過 `node-edge-tts` 函式庫使用 Microsoft Edge 的線上神經語音合成服務。
它是一個託管服務 (非本地)，使用 Microsoft 的端點，並且不需要 API 密鑰。
`node-edge-tts` 暴露了語音設定選項和輸出格式，但並非所有選項都受到 Edge 服務的支援。 citeturn2search0

由於 Edge TTS 是一個沒有公開服務水準協定 (SLA) 或配額的公共網路服務，請將其視為盡力服務。
如果您需要有保障的限制和支援，請使用 OpenAI 或 ElevenLabs。
Microsoft 的語音 REST API 文件記載了每次請求 10 分鐘的音訊限制；Edge TTS
並未公布限制，因此請假設相似或更低的限制。 citeturn0search3

## 可選密鑰

如果您想要使用 OpenAI 或 ElevenLabs：

- `ELEVENLABS_API_KEY` (或 `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **不**需要 API 密鑰。如果沒有找到 API 密鑰，OpenClaw 預設使用 Edge TTS
(除非透過 `messages.tts.edge.enabled=false` 停用)。

如果配置了多個供應商，則選定的供應商會優先使用，其他供應商則作為備援選項。
自動摘要使用配置的 `summaryModel` (或 `agents.defaults.model.primary`)，
因此如果您啟用摘要，該供應商也必須經過身份驗證。

## 服務連結

- [OpenAI 語音合成指南](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI 音訊 API 參考](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 語音合成](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 身份驗證](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft 語音輸出格式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 預設啟用嗎？

不。自動 TTS 預設為**關閉**。可在設定中透過
`messages.tts.auto` 啟用，或在每個工作階段中透過 `/tts always` (別名: `/tts on`) 啟用。

Edge TTS 在 TTS 啟用後**會**預設啟用，並且在沒有 OpenAI 或 ElevenLabs API 密鑰時自動使用。

## 設定

TTS 設定位於 `openclaw.json` 的 `messages.tts` 下。
完整的結構描述請參閱 [Gateway 設定](/gateway/configuration)。

### 最簡設定 (啟用 + 供應商)

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

### OpenAI 為主要供應商，ElevenLabs 為備援

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

### Edge TTS 為主要供應商 (無 API 密鑰)

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

### 僅在收到入站語音備忘錄後回覆音訊

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

### 關於欄位的說明

- `auto`: 自動 TTS 模式 (`off`、`always`、`inbound`、`tagged`)。
  - `inbound` 僅在收到入站語音備忘錄後傳送音訊。
  - `tagged` 僅在回覆包含 `[[tts]]` 標籤時傳送音訊。
- `enabled`: 舊版開關 (醫生會將其遷移到 `auto`)。
- `mode`: `"final"` (預設) 或 `"all"` (包含工具/區塊回覆)。
- `provider`: `"elevenlabs"`、`"openai"` 或 `"edge"` (備援是自動的)。
- 如果 `provider` **未設定**，OpenClaw 會優先使用 `openai` (如果有密鑰)，然後是 `elevenlabs` (如果有密鑰)，
  否則使用 `edge`。
- `summaryModel`: 用於自動摘要的可選廉價模型；預設為 `agents.defaults.model.primary`。
  - 接受 `provider/model` 或已配置的模型別名。
- `modelOverrides`: 允許模型發出 TTS 指令 (預設為開啟)。
- `maxTextLength`: TTS 輸入的硬性上限 (字元)。如果超出，`/tts audio` 會失敗。
- `timeoutMs`: 請求逾時 (毫秒)。
- `prefsPath`: 覆寫本地偏好設定 JSON 路徑 (供應商/限制/摘要)。
- `apiKey` 值會回溯到環境變數 (`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`)。
- `elevenlabs.baseUrl`: 覆寫 ElevenLabs API 基礎 URL。
- `elevenlabs.voiceSettings`:
  - `stability`、`similarityBoost`、`style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = 正常)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2 個字母的 ISO 639-1 (例如 `en`、`de`)
- `elevenlabs.seed`: 整數 `0..4294967295` (盡力實現確定性)
- `edge.enabled`: 允許使用 Edge TTS (預設 `true`；無需 API 密鑰)。
- `edge.voice`: Edge 神經語音名稱 (例如 `en-US-MichelleNeural`)。
- `edge.lang`: 語言代碼 (例如 `en-US`)。
- `edge.outputFormat`: Edge 輸出格式 (例如 `audio-24khz-48kbitrate-mono-mp3`)。
  - 有效值請參閱 Microsoft 語音輸出格式；並非所有格式都受 Edge 服務支援。
  - 輸出格式值遵循 Microsoft 語音輸出格式 (包括 Ogg/WebM Opus)。 citeturn1search0
  - Telegram `sendVoice` 接受 OGG/MP3/M4A；如果您需要有保障的 Opus 語音備忘錄，請使用 OpenAI/ElevenLabs。 citeturn1search1
  - 如果配置的 Edge 輸出格式失敗，OpenClaw 會使用 MP3 重試。

OpenAI/ElevenLabs 格式是固定的；Telegram 期待 Opus 用於語音備忘錄的用戶體驗。

## 模型驅動的覆寫 (預設啟用)

預設情況下，模型**可以**為單次回覆發出 TTS 指令。
當 `messages.tts.auto` 為 `tagged` 時，這些指令是觸發音訊所必需的。

啟用後，模型可以發出 `[[tts:...]]` 指令來覆寫單次回覆的語音，
以及一個可選的 `[[tts:text]]...[[/tts:text]]` 區塊，以提供僅應出現在音訊中的
表達性標籤 (笑聲、歌唱提示等)。

範例回覆負載：

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

可用的指令鍵 (啟用時)：

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI 語音) 或 `voiceId` (ElevenLabs)
- `model` (OpenAI TTS 模型或 ElevenLabs 模型 ID)
- `stability`、`similarityBoost`、`style`、`speed`、`useSpeakerBoost`
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

可選的允許清單 (在啟用標籤的同時停用特定的覆寫)：

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

斜線指令會將本地覆寫寫入 `prefsPath` (預設:
`~/.openclaw/settings/tts.json`，可透過 `OPENCLAW_TTS_PREFS` 或
`messages.tts.prefsPath` 覆寫)。

儲存的欄位：

- `enabled`
- `provider`
- `maxLength` (摘要閾值；預設 1500 字元)
- `summarize` (預設 `true`)

這些會覆寫該主機的 `messages.tts.*`。

## 輸出格式 (固定)

- **Telegram**: Opus 語音備忘錄 (ElevenLabs 的 `opus_48000_64`，OpenAI 的 `opus`)。
  - 48kHz / 64kbps 是語音備忘錄的良好權衡，並且是圓形氣泡所需的。
- **其他頻道**: MP3 (ElevenLabs 的 `mp3_44100_128`，OpenAI 的 `mp3`)。
  - 44.1kHz / 128kbps 是語音清晰度的預設平衡。
- **Edge TTS**: 使用 `edge.outputFormat` (預設 `audio-24khz-48kbitrate-mono-mp3`)。
  - `node-edge-tts` 接受 `outputFormat`，但並非所有格式都可從 Edge 服務獲得。 citeturn2search0
  - 輸出格式值遵循 Microsoft 語音輸出格式 (包括 Ogg/WebM Opus)。 citeturn1search0
  - Telegram `sendVoice` 接受 OGG/MP3/M4A；如果您需要有保障的 Opus 語音備忘錄，請使用 OpenAI/ElevenLabs。 citeturn1search1
  - 如果配置的 Edge 輸出格式失敗，OpenClaw 會使用 MP3 重試。

OpenAI/ElevenLabs 格式是固定的；Telegram 期待 Opus 用於語音備忘錄的用戶體驗。

## 自動 TTS 行為

啟用後，OpenClaw 會：

- 如果回覆已包含媒體或 `MEDIA:` 指令，則跳過 TTS。
- 跳過非常短的回覆 (< 10 個字元)。
- 啟用時，使用 `agents.defaults.model.primary` (或 `summaryModel`) 摘要長回覆。
- 將生成的音訊附加到回覆中。

如果回覆超出 `maxLength` 且摘要關閉 (或摘要模型沒有 API 密鑰)，則會跳過音訊
並傳送正常的文字回覆。

## 流程圖

```
回覆 -> TTS 啟用？
  否  -> 傳送文字
  是 -> 有媒體 / MEDIA: / 短回覆？
          是 -> 傳送文字
          否  -> 長度 > 限制？
                   否  -> TTS -> 附加音訊
                   是 -> 摘要啟用？
                            否  -> 傳送文字
                            是 -> 摘要 (summaryModel 或 agents.defaults.model.primary)
                                      -> TTS -> 附加音訊
```

## 斜線指令用法

只有一個指令：`/tts`。
有關啟用詳情，請參閱 [斜線指令](/tools/slash-commands)。

Discord 說明：`/tts` 是 Discord 內建指令，因此 OpenClaw 會在那裡將
`/voice` 註冊為原生指令。文字 `/tts ...` 仍然有效。

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

- 指令需要授權的傳送者 (允許清單/所有者規則仍然適用)。
- 必須啟用 `commands.text` 或原生指令註冊。
- `off|always|inbound|tagged` 是每個工作階段的開關 (`/tts on` 是 `/tts always` 的別名)。
- `limit` 和 `summary` 儲存在本地偏好設定中，而不是主設定。
- `/tts audio` 生成一次性音訊回覆 (不會開啟 TTS)。

## 智慧代理工具

`tts` 工具將文字轉換為語音並傳回 `MEDIA:` 路徑。當結果與 Telegram 相容時，該工具包含
`[[audio_as_voice]]`，以便 Telegram 傳送語音氣泡。

## Gateway RPC

Gateway 方法：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
```
