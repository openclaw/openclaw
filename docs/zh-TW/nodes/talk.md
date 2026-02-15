---
summary: "Talk 模式：使用 ElevenLabs TTS 進行連續語音對話"
read_when:
  - 在 macOS/iOS/Android 上實作 Talk 模式
  - 變更語音/TTS/中斷行為
title: "Talk 模式"
---

# Talk 模式

Talk 模式是一個連續的語音對話迴圈：

1. 監聽語音
2. 將逐字稿傳送至模型 (main 工作階段, chat.send)
3. 等待回應
4. 透過 ElevenLabs 播放 (串流播放)

## 行為 (macOS)

- 啟用 Talk 模式時，會顯示常駐的重疊視窗 (overlay)。
- 監聽中 → 思考中 → 說話中 階段轉換。
- 短暫停頓（靜音視窗）後，會傳送目前的逐字稿。
- 回覆會寫入 WebChat（與打字相同）。
- **語音中斷**（預設開啟）：若使用者在智慧代理說話時開始交談，我們會停止播放並記錄中斷的時間點，供下一次提示詞 (prompt) 使用。

## 回覆中的語音指令

智慧代理可能會在回覆開頭加上單行 JSON 來控制語音：

```json
{ "voice": "<voice-id>", "once": true }
```

規則：

- 僅限第一行非空行。
- 忽略未知的鍵名。
- `once: true` 僅套用於目前的回覆。
- 若未設定 `once`，該語音將成為 Talk 模式的新預設值。
- JSON 行在 TTS 播放前會被移除。

支援的鍵名：

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
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
    interruptOnSpeech: true,
  },
}
```

預設值：

- `interruptOnSpeech`: true
- `voiceId`: 回退 (fallback) 至 `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`（或在 API key 可用時使用第一個 ElevenLabs 語音）
- `modelId`: 未設定時預設為 `eleven_v3`
- `apiKey`: 回退至 `ELEVENLABS_API_KEY`（或 Gateway shell profile，若可用）
- `outputFormat`: 在 macOS/iOS 預設為 `pcm_44100`，Android 預設為 `pcm_24000`（設定 `mp3_*` 可強制使用 MP3 串流）

## macOS 使用者介面

- 選單列切換：**Talk**
- 設定分頁：**Talk 模式**群組 (voice id + 中斷切換)
- 重疊視窗 (Overlay)：
  - **監聽中**：雲朵隨麥克風音量跳動
  - **思考中**：下沉動畫
  - **說話中**：擴散圓環
  - 點擊雲朵：停止說話
  - 點擊 X：退出 Talk 模式

## 注意事項

- 需要語音與麥克風權限。
- 對 `main` 工作階段鍵值使用 `chat.send`。
- TTS 使用 ElevenLabs 串流 API 與 `ELEVENLABS_API_KEY`，並在 macOS/iOS/Android 上使用增量播放以降低延遲。
- `eleven_v3` 的 `stability` 驗證值為 `0.0`、`0.5` 或 `1.0`；其他模型接受 `0..1`。
- 設定時 `latency_tier` 的驗證值為 `0..4`。
- Android 支援 `pcm_16000`、`pcm_22050`、`pcm_24000` 與 `pcm_44100` 輸出格式，用於低延遲的 AudioTrack 串流。
