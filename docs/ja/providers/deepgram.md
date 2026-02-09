---
summary: "インバウンド音声メモ向けの Deepgram 文字起こし"
read_when:
  - 音声添付に Deepgram の音声認識を使いたい場合
  - Deepgram の簡単な設定例が必要な場合
title: "Deepgram"
---

# Deepgram（音声文字起こし）

Deepgram は音声認識（speech-to-text）API です。OpenClaw では、**インバウンドの音声／ボイスノートの文字起こし** に `tools.media.audio` を介して使用されます。 OpenClawでは、`tools.media.audio`を介して**音声/音声音符
トランスクリプト**に使用されます。

有効化すると、OpenClaw は音声ファイルを Deepgram にアップロードし、文字起こし結果を返信パイプライン（`{{Transcript}}` + `[Audio]` ブロック）に注入します。これは**ストリーミングではありません**。事前録音向けの文字起こしエンドポイントを使用します。 これは**ストリーミングしません**;
は事前に記録された転写エンドポイントを使用します。

Web サイト: [https://deepgram.com](https://deepgram.com)  
ドキュメント: [https://developers.deepgram.com](https://developers.deepgram.com)

## クイックスタート

1. API キーを設定します。

```
DEEPGRAM_API_KEY=dg_...
```

2. プロバイダを有効化:

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

## オプション

- `model`: Deepgram モデル ID（デフォルト: `nova-3`）
- `language`: 言語ヒント（任意）
- `tools.media.audio.providerOptions.deepgram.detect_language`: 言語検出を有効化（任意）
- `tools.media.audio.providerOptions.deepgram.punctuate`: 句読点を有効化（任意）
- `tools.media.audio.providerOptions.deepgram.smart_format`: スマートフォーマットを有効化（任意）

言語指定の例:

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

Deepgram オプション指定の例:

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

## 注記

- 認証は標準のプロバイダー認証順に従います。`DEEPGRAM_API_KEY` が最も簡単な方法です。
- プロキシを使用する場合、`tools.media.audio.baseUrl` および `tools.media.audio.headers` でエンドポイントやヘッダーを上書きできます。
- 出力は他のプロバイダーと同じ音声ルール（サイズ上限、タイムアウト、文字起こしの注入）に従います。
