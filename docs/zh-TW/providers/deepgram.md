---
summary: "用於入站語音訊息的 Deepgram 轉錄"
read_when:
  - 你需要將 Deepgram 語音轉文字用於音訊附件
  - 你需要一個快速的 Deepgram 設定範例
title: "Deepgram"
---

# Deepgram（音訊轉錄）

Deepgram 是一個語音轉文字 API。在 OpenClaw 中，它用於透過 `tools.media.audio` 進行**入站音訊／語音訊息轉錄**。 In OpenClaw it is used for **inbound audio/voice note
transcription** via `tools.media.audio`.

啟用後，OpenClaw 會將音訊檔案上傳至 Deepgram，並將轉錄結果注入回覆管線（`{{Transcript}}` + `[Audio]` 區塊）。這**不是串流**；它使用預先錄製的轉錄端點。 3. 這**不是串流**；
它使用預先錄製的轉錄端點。

網站：[https://deepgram.com](https://deepgram.com)  
文件：[https://developers.deepgram.com](https://developers.deepgram.com)

## 快速開始

1. 設定你的 API 金鑰：

```
DEEPGRAM_API_KEY=dg_...
```

2. 啟用提供者：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 選項

- `model`：Deepgram 模型 ID（預設：`nova-3`）
- `language`：語言提示（選用）
- `tools.media.audio.providerOptions.deepgram.detect_language`：啟用語言偵測（選用）
- `tools.media.audio.providerOptions.deepgram.punctuate`：啟用標點符號（選用）
- `tools.media.audio.providerOptions.deepgram.smart_format`：啟用智慧格式化（選用）

含語言的範例：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

含 Deepgram 選項的範例：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 注意事項

- 身分驗證遵循標準提供者驗證順序；`DEEPGRAM_API_KEY` 是最簡單的途徑。
- 使用代理時，可透過 `tools.media.audio.baseUrl` 與 `tools.media.audio.headers` 覆寫端點或標頭。
- 輸出遵循與其他提供者相同的音訊規則（大小上限、逾時、轉錄注入）。
