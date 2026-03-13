---
summary: "Talk mode: continuous speech conversations with ElevenLabs TTS"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Changing voice/TTS/interrupt behavior
title: Talk Mode
---

# 談話模式

談話模式是一個持續的語音對話循環：

1. 聆聽語音
2. 將轉錄文字傳送給模型（主會話，chat.send）
3. 等待回應
4. 透過 ElevenLabs 進行語音播放（串流播放）

## 行為（macOS）

- 啟用談話模式時，**持續顯示覆蓋層**。
- **聆聽 → 思考 → 說話** 階段轉換。
- 在**短暫停頓**（靜音時間）時，會送出當前轉錄文字。
- 回覆會**寫入 WebChat**（與打字相同）。
- **語音中斷**（預設開啟）：當助理正在說話時，若使用者開始講話，會停止播放並記錄中斷時間戳，作為下一次提示使用。

## 回覆中的語音指令

助理可能會在回覆前加上一行**單行 JSON**來控制語音：

```json
{ "voice": "<voice-id>", "once": true }
```

規則：

- 只取第一個非空行。
- 不認識的鍵會被忽略。
- `once: true` 僅適用於當前回覆。
- 若無 `once`，該語音設定會成為談話模式的新預設。
- 播放前會移除該 JSON 行。

支援的鍵：

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate`（字數每分鐘 WPM）, `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## 設定 (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
  },
}
```

預設值：

- `interruptOnSpeech`: 是
- `silenceTimeoutMs`: 未設定時，Talk 會在傳送文字稿前保留平台預設的暫停視窗 (`700 ms on macOS and Android, 900 ms on iOS`)
- `voiceId`: 回退至 `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`（或在有 API 金鑰時使用第一個 ElevenLabs 聲音）
- `modelId`: 未設定時預設為 `eleven_v3`
- `apiKey`: 回退至 `ELEVENLABS_API_KEY`（或若有 gateway shell 設定檔則使用該設定檔）
- `outputFormat`: macOS/iOS 預設為 `pcm_44100`，Android 預設為 `pcm_24000`（設定 `mp3_*` 可強制使用 MP3 串流）

## macOS 使用者介面

- 功能表列切換：**Talk**
- 設定標籤：**Talk 模式** 群組（語音 ID + 中斷切換）
- 覆蓋顯示：
  - **聆聽中**：雲朵隨麥克風音量脈動
  - **思考中**：下沉動畫
  - **講話中**：放射狀環圈
  - 點擊雲朵：停止講話
  - 點擊 X：退出 Talk 模式

## 注意事項

- 需要語音與麥克風權限。
- 使用 `chat.send` 對應會話金鑰 `main`。
- TTS 使用 ElevenLabs 串流 API 搭配 `ELEVENLABS_API_KEY`，並在 macOS/iOS/Android 上支援漸進式播放以降低延遲。
- `stability` 用於 `eleven_v3`，並驗證為 `0.0`、`0.5` 或 `1.0`；其他模型接受 `0..1`。
- 設定 `latency_tier` 時會驗證為 `0..4`。
- Android 支援 `pcm_16000`、`pcm_22050`、`pcm_24000` 及 `pcm_44100` 輸出格式，以實現低延遲的 AudioTrack 串流。
