---
summary: "用於外送回覆的文字轉語音（TTS）"
read_when:
  - 為回覆啟用文字轉語音
  - 設定 TTS 提供者或限制
  - 使用 /tts 指令
title: "Text-to-Speech"
---

# 文字轉語音（TTS）

OpenClaw can convert outbound replies into audio using ElevenLabs, OpenAI, or Edge TTS.
OpenClaw 可以使用 ElevenLabs、OpenAI 或 Edge TTS，將外送回覆轉換為音訊。
凡是 OpenClaw 能傳送音訊的地方都可運作；Telegram 會顯示為圓形語音訊息氣泡。

## 支援的服務

- **ElevenLabs**（主要或備援提供者）
- **OpenAI**（主要或備援提供者；也用於摘要）
- **Edge TTS**（主要或備援提供者；使用 `node-edge-tts`，在沒有 API 金鑰時為預設）

### Edge TTS 注意事項

Edge TTS 透過 `node-edge-tts` 程式庫使用 Microsoft Edge 的線上神經 TTS 服務。這是託管服務（非本機），使用 Microsoft 的端點，且不需要 API 金鑰。`node-edge-tts` 提供語音設定選項與輸出格式，但並非所有選項都受 Edge 服務支援。citeturn2search0 這是託管服務（非本機），使用 Microsoft 的端點，且
不需要 API 金鑰。 `node-edge-tts` 提供語音設定選項與
輸出格式，但並非所有選項都受 Edge 服務支援。 citeturn2search0

由於 Edge TTS 是沒有公開 SLA 或配額的公共網路服務，請將其
視為盡力而為。 如果你需要保證的限制與支援，請使用 OpenAI 或 ElevenLabs。
由於 Edge TTS 是未公布 SLA 或配額的公開網路服務，請將其視為盡力而為（best‑effort）。若需要保證的限制與支援，請使用 OpenAI 或 ElevenLabs。Microsoft 的 Speech REST API 文件指出每次請求的音訊上限為 10 分鐘；Edge TTS 未公布限制，請假設相同或更低的限制。citeturn0search3 citeturn0search3

## 可選金鑰

若要使用 OpenAI 或 ElevenLabs：

- `ELEVENLABS_API_KEY`（或 `XI_API_KEY`）
- `OPENAI_API_KEY`

Edge TTS does **not** require an API key. Edge TTS **不**需要 API 金鑰。若未找到任何 API 金鑰，OpenClaw 會預設使用 Edge TTS（除非透過 `messages.tts.edge.enabled=false` 停用）。

若設定了多個供應商，會先使用所選供應商，其餘作為備援選項。
若設定了多個提供者，會先使用選定的提供者，其餘作為備援。
自動摘要會使用設定的 `summaryModel`（或 `agents.defaults.model.primary`），
因此若啟用摘要，該提供者也必須完成身分驗證。

## 服務連結

- [OpenAI Text-to-Speech 指南](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API 參考](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs 文字轉語音](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs 身分驗證](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech 輸出格式](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## 預設是否啟用？

否. Auto‑TTS is **off** by default. 否。自動 TTS 預設為 **關閉**。請在設定中以
`messages.tts.auto` 啟用，或在每個工作階段以 `/tts always`（別名：`/tts on`）啟用。

一旦開啟 TTS，Edge TTS **預設為啟用**，且在沒有 OpenAI 或 ElevenLabs API 金鑰時會自動使用。

## 設定

TTS 設定位於 `openclaw.json` 中的 `messages.tts`。
完整結構請見 [Gateway 設定](/gateway/configuration)。
Full schema is in [Gateway configuration](/gateway/configuration).

### 最小設定（啟用 + 提供者）

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

### OpenAI 為主要，ElevenLabs 為備援

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

### Edge TTS 為主要（無 API 金鑰）

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

Then run:

```
/tts summary off
```

### 欄位說明

- `auto`：自動 TTS 模式（`off`、`always`、`inbound`、`tagged`）。
  - `inbound`：僅在收到語音訊息後才傳送音訊。
  - `tagged`：僅當回覆包含 `[[tts]]` 標籤時才傳送音訊。
- `enabled`：舊版開關（doctor 會將其遷移至 `auto`）。
- `mode`：`"final"`（預設）或 `"all"`（包含工具/區塊回覆）。
- `provider`：`"elevenlabs"`、`"openai"` 或 `"edge"`（會自動備援）。
- 若 `provider` **未設定**，OpenClaw 會偏好 `openai`（若有金鑰），其次 `elevenlabs`（若有金鑰），否則使用 `edge`。
- `summaryModel`：自動摘要的可選低成本模型；預設為 `agents.defaults.model.primary`。
  - 可接受 `provider/model` 或已設定的模型別名。
- `modelOverrides`：允許模型輸出 TTS 指令（預設開啟）。
- `maxTextLength`：TTS 輸入的硬性上限（字元）。超過時 `/tts audio` 會失敗。 `/tts audio` fails if exceeded.
- `timeoutMs`：請求逾時（毫秒）。
- `prefsPath`：覆寫本機偏好設定 JSON 路徑（提供者/限制/摘要）。
- `apiKey` 的值會回退至環境變數（`ELEVENLABS_API_KEY`/`XI_API_KEY`、`OPENAI_API_KEY`）。
- `elevenlabs.baseUrl`：覆寫 ElevenLabs API 基底 URL。
- `elevenlabs.voiceSettings`：
  - `stability`、`similarityBoost`、`style`：`0..1`
  - `useSpeakerBoost`：`true|false`
  - `speed`：`0.5..2.0`（1.0 = 正常）
- `elevenlabs.applyTextNormalization`：`auto|on|off`
- `elevenlabs.languageCode`：2 字母 ISO 639-1（例如 `en`、`de`）
- `elevenlabs.seed`：整數 `0..4294967295`（盡力提供可重現性）
- `edge.enabled`：允許使用 Edge TTS（預設 `true`；不需 API 金鑰）。
- `edge.voice`：Edge 神經語音名稱（例如 `en-US-MichelleNeural`）。
- `edge.lang`：語言代碼（例如 `en-US`）。
- `edge.outputFormat`：Edge 輸出格式（例如 `audio-24khz-48kbitrate-mono-mp3`）。
  - 有效值請見 Microsoft Speech 輸出格式；並非所有格式都受 Edge 支援。
- `edge.rate` / `edge.pitch` / `edge.volume`：百分比字串（例如 `+10%`、`-5%`）。
- `edge.saveSubtitles`：在音訊檔旁寫入 JSON 字幕。
- `edge.proxy`：Edge TTS 請求的 Proxy URL。
- `edge.timeoutMs`：請求逾時覆寫（毫秒）。

## Model-driven overrides (default on)

By default, the model **can** emit TTS directives for a single reply.
When `messages.tts.auto` is `tagged`, these directives are required to trigger audio.

啟用後，模型可輸出 `[[tts:...]]` 指令以覆寫單一回覆的語音，
並可選擇加入 `[[tts:text]]...[[/tts:text]]` 區塊，
提供僅應出現在音訊中的表情標記（笑聲、歌唱提示等）。

回覆負載範例：

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

可用的指令鍵（啟用時）：

- `provider`（`openai` | `elevenlabs` | `edge`）
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

可選允許清單（在保留標籤啟用的同時，停用特定覆寫）：

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

斜線指令會將本機覆寫寫入 `prefsPath`（預設：
`~/.openclaw/settings/tts.json`，可用 `OPENCLAW_TTS_PREFS` 或
`messages.tts.prefsPath` 覆寫）。

儲存的欄位：

- `enabled`
- `provider`
- `maxLength`（摘要門檻；預設 1500 字元）
- `summarize`（預設 `true`）

這些設定會覆寫該主機的 `messages.tts.*`。

## 輸出格式（固定）

- **Telegram**：Opus 語音訊息（ElevenLabs 為 `opus_48000_64`，OpenAI 為 `opus`）。
  - 48kHz / 64kbps 是良好的語音訊息折衷，且為圓形氣泡所需。
- **其他頻道**：MP3（ElevenLabs 為 `mp3_44100_128`，OpenAI 為 `mp3`）。
  - 44.1kHz / 128kbps 是語音清晰度的預設平衡。
- **Edge TTS**：使用 `edge.outputFormat`（預設 `audio-24khz-48kbitrate-mono-mp3`）。
  - `node-edge-tts` 可接受 `outputFormat`，但並非所有格式都可由 Edge 服務提供。citeturn2search0 citeturn2search0
  - 輸出格式值遵循 Microsoft Speech 輸出格式（包含 Ogg/WebM Opus）。citeturn1search0 citeturn1search0
  - Telegram 的 `sendVoice` 接受 OGG/MP3/M4A；若需要保證的 Opus 語音訊息，請使用 OpenAI/ElevenLabs。citeturn1search1 citeturn1search1
  - 若設定的 Edge 輸出格式失敗，OpenClaw 會以 MP3 重試。

OpenAI/ElevenLabs 的格式為固定；Telegram 的語音訊息 UX 期望 Opus。

## 自動 TTS 行為

啟用後，OpenClaw 會：

- 若回覆已包含媒體或 `MEDIA:` 指令，則略過 TTS。
- 略過非常短的回覆（< 10 字元）。
- 啟用時，使用 `agents.defaults.model.primary`（或 `summaryModel`）對長回覆進行摘要。
- 將產生的音訊附加到回覆中。

若回覆超過 `maxLength` 且摘要為關閉（或摘要模型沒有 API 金鑰），
則會略過音訊並傳送一般文字回覆。

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

## Slash command usage

只有一個指令：`/tts`。
啟用細節請見 [斜線指令](/tools/slash-commands)。1) 請參閱 [Slash commands](/tools/slash-commands) 以了解啟用細節。

Discord 注意事項：`/tts` 是 Discord 內建指令，因此 OpenClaw 會在該處註冊
`/voice` 作為原生命令。文字 `/tts ...` 仍可使用。 2. 文字指令 `/tts ...` 仍然可用。

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

- 指令需要已授權的寄件者（仍適用允許清單/擁有者規則）。
- 必須啟用 `commands.text` 或原生命令註冊。
- `off|always|inbound|tagged` 為每個工作階段的切換（`/tts on` 是 `/tts always` 的別名）。
- `limit` and `summary` are stored in local prefs, not the main config.
- `/tts audio` 會產生一次性的音訊回覆（不會切換 TTS 開啟狀態）。

## 代理程式工具

`tts` 工具會將文字轉為語音並回傳一個 `MEDIA:` 路徑。當結果與 Telegram 相容時，該工具會包含 `[[audio_as_voice]]`，使 Telegram 送出語音氣泡。 When the
result is Telegram-compatible, the tool includes `[[audio_as_voice]]` so
Telegram sends a voice bubble.

## Gateway RPC

Gateway 方法：

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
