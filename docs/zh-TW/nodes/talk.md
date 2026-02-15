---
summary: "交談模式：與 ElevenLabs TTS 進行連續語音對話"
read_when:
  - 在 macOS/iOS/Android 上實作交談模式
  - 變更語音/TTS/打斷行為
title: "交談模式"
---

# 交談模式

交談模式是一個連續的語音對話循環：

1.  聆聽語音
2.  將文字稿傳送給模型 (主要工作階段, chat.send)
3.  等待回應
4.  透過 ElevenLabs 說出回應 (串流播放)

## 行為 (macOS)

-   在啟用交談模式時，會顯示**始終開啟的浮動視窗**。
-   **聆聽 → 思考 → 說話**的階段轉換。
-   在**短暫停頓** (靜音視窗) 時，會傳送目前的文字稿。
-   回覆會**寫入 WebChat** (與打字相同)。
-   **語音打斷** (預設開啟)：如果使用者在智慧代理說話時開始說話，我們會停止播放並記錄下一次提示的打斷時間戳記。

## 回覆中的語音指令

智慧代理可以在其回覆中以**單一 JSON 行**作為前綴來控制語音：

```json
{ "voice": "<voice-id>", "once": true }
```

規則：

-   僅限第一個非空行。
-   未知鍵名會被忽略。
-   `once: true` 僅適用於目前的回覆。
-   如果沒有 `once`，則該語音會成為交談模式的新預設值。
-   在 TTS 播放之前，JSON 行會被移除。

支援的鍵名：

-   `voice` / `voice_id` / `voiceId`
-   `model` / `model_id` / `modelId`
-   `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
-   `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
-   `once`

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

-   `interruptOnSpeech`: true
-   `voiceId`: 回退到 `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (或當 API 鍵可用時，第一個 ElevenLabs 語音)
-   `modelId`: 未設定時預設為 `eleven_v3`
-   `apiKey`: 回退到 `ELEVENLABS_API_KEY` (或可用的 Gateway shell 設定檔)
-   `outputFormat`: 在 macOS/iOS 上預設為 `pcm_44100`，在 Android 上預設為 `pcm_24000` (設定 `mp3_*` 以強制 MP3 串流傳輸)

## macOS 使用者介面

-   選單列切換：**交談**
-   設定分頁：**交談模式**群組 (語音 ID + 打斷切換)
-   浮動視窗：
    -   **聆聽中**：雲朵隨著麥克風音量脈動
    -   **思考中**：下沉動畫
    -   **說話中**：環狀輻射
    -   點擊雲朵：停止說話
    -   點擊 X：退出交談模式

## 備註

-   需要語音 + 麥克風權限。
-   使用 `chat.send` 對應工作階段鍵 `main`。
-   TTS 使用 ElevenLabs 串流 API 與 `ELEVENLABS_API_KEY`，並在 macOS/iOS/Android 上進行增量播放以降低延遲。
-   `eleven_v3` 的 `stability` 經驗證為 `0.0`、`0.5` 或 `1.0`；其他模型接受 `0..1`。
-   設定 `latency_tier` 時，會驗證為 `0..4`。
-   Android 支援 `pcm_16000`、`pcm_22050`、`pcm_24000` 和 `pcm_44100` 輸出格式，用於低延遲 AudioTrack 串流傳輸。
