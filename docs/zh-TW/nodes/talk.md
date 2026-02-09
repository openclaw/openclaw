---
summary: "Talk 模式：使用 ElevenLabs TTS 的連續語音對話"
read_when:
  - 在 macOS／iOS／Android 上實作 Talk 模式
  - 變更語音／TTS／中斷行為
title: "Talk 模式"
---

# Talk 模式

Talk 模式是一個連續的語音對話循環：

1. 聆聽語音
2. 將逐字稿傳送給模型（主工作階段，chat.send）
3. 等待回應
4. 透過 ElevenLabs 朗讀（串流播放）

## 行為（macOS）

- 在啟用 Talk 模式時，**常駐顯示的覆蓋層**。
- **聆聽 → 思考 → 說話** 的階段轉換。
- 在**短暫暫停**（靜默視窗）時，會送出目前的逐字稿。
- 回覆會**寫入 WebChat**（與鍵入相同）。
- **語音中斷**（預設開啟）：若使用者在助理說話時開始發言，將停止播放，並為下一個提示記錄中斷時間戳。

## 回覆中的語音指令

助理可在回覆前加上一行**單行 JSON** 以控制語音：

```json
{ "voice": "<voice-id>", "once": true }
```

規則：

- 僅限第一個非空白行。
- 未知的鍵會被忽略。
- `once: true` 僅套用於當前回覆。
- 若未指定 `once`，該語音將成為 Talk 模式的新預設。
- 在 TTS 播放前會移除該 JSON 行。

支援的鍵：

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate`（WPM）, `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## 設定（`~/.openclaw/openclaw.json`）

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

預設值：

- `interruptOnSpeech`: true
- `voiceId`: 會回退至 `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`（或在可用 API 金鑰時使用第一個 ElevenLabs 語音）
- `modelId`: 未設定時預設為 `eleven_v3`
- `apiKey`: 會回退至 `ELEVENLABS_API_KEY`（或可用時使用 Gateway 閘道器 的 shell 設定檔）
- `outputFormat`: 在 macOS／iOS 上預設為 `pcm_44100`，在 Android 上預設為 `pcm_24000`（設定 `mp3_*` 以強制 MP3 串流）

## macOS UI

- 選單列切換：**Talk**
- 設定分頁：**Talk 模式** 群組（語音 ID ＋ 中斷切換）
- Overlay:
  - **聆聽**：雲朵隨麥克風音量脈動
  - **思考**：下沉動畫
  - **說話**：放射狀圓環
  - 點擊雲朵：停止說話
  - 點擊 X：離開 Talk 模式

## 注意事項

- 需要語音與麥克風權限。
- 針對工作階段金鑰 `main` 使用 `chat.send`。
- TTS 使用 ElevenLabs 串流 API，搭配 `ELEVENLABS_API_KEY`，並在 macOS／iOS／Android 上進行漸進式播放以降低延遲。
- `stability` 的 `eleven_v3` 會驗證為 `0.0`、`0.5` 或 `1.0`；其他模型接受 `0..1`。
- 設定時，`latency_tier` 會驗證為 `0..4`。
- Android 支援 `pcm_16000`、`pcm_22050`、`pcm_24000` 與 `pcm_44100` 輸出格式，以進行低延遲的 AudioTrack 串流。
