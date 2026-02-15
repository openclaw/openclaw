---
summary: "Deepgram 傳入語音備忘錄轉錄"
read_when:
  - 當您需要 Deepgram 語音轉文字功能用於音訊附件時
  - 當您需要快速 Deepgram 設定範例時
title: "Deepgram"
---

# Deepgram (音訊轉錄)

Deepgram 是一個語音轉文字 API。在 OpenClaw 中，它透過 `tools.media.audio` 用於**傳入音訊/語音備忘錄轉錄**。

啟用後，OpenClaw 會將音訊檔案上傳到 Deepgram 並將轉錄稿注入回覆管道（`{{Transcript}}` + `[Audio]` 區塊）。這**不是串流傳輸**；它使用預錄的轉錄端點。

網站：[https://deepgram.com](https://deepgram.com)  
文件：[https://developers.deepgram.com](https://developers.deepgram.com)

## 快速開始

1. 設定您的 API 金鑰：

```
DEEPGRAM_API_KEY=dg_...
```

2. 啟用供應商：

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

- `model`：Deepgram 模型 ID（預設值：`nova-3`）
- `language`：語言提示（選用）
- `tools.media.audio.providerOptions.deepgram.detect_language`：啟用語言偵測（選用）
- `tools.media.audio.providerOptions.deepgram.punctuate`：啟用標點符號（選用）
- `tools.media.audio.providerOptions.deepgram.smart_format`：啟用智慧格式化（選用）

語言範例：

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

Deepgram 選項範例：

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

## 備註

- 身份驗證遵循標準的供應商身份驗證順序；`DEEPGRAM_API_KEY` 是最簡單的路徑。
- 使用 `tools.media.audio.baseUrl` 和 `tools.media.audio.headers` 覆寫端點或標頭，當使用代理伺服器時。
- 輸出遵循與其他供應商相同的音訊規則（大小限制、逾時、轉錄稿注入）。
