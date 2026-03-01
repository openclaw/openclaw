---
summary: "受信音声メモのDeepgram文字起こし"
read_when:
  - 音声添付ファイルにDeepgramの音声テキスト変換を使いたい場合
  - Deepgramの設定例が必要な場合
title: "Deepgram"
---

# Deepgram（音声文字起こし）

Deepgramは音声テキスト変換APIです。OpenClawでは `tools.media.audio` を通じた**受信音声/ボイスノートの文字起こし**に使用されます。

有効にすると、OpenClawは音声ファイルをDeepgramにアップロードし、文字起こし結果を返信パイプラインに注入します（`{{Transcript}}` + `[Audio]` ブロック）。これは**ストリーミングではなく**、事前録音済みの文字起こしエンドポイントを使用します。

ウェブサイト: [https://deepgram.com](https://deepgram.com)
ドキュメント: [https://developers.deepgram.com](https://developers.deepgram.com)

## クイックスタート

1. APIキーを設定する:

```
DEEPGRAM_API_KEY=dg_...
```

2. プロバイダーを有効にする:

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

- `model`: DeepgramモデルID（デフォルト: `nova-3`）
- `language`: 言語ヒント（オプション）
- `tools.media.audio.providerOptions.deepgram.detect_language`: 言語検出を有効にする（オプション）
- `tools.media.audio.providerOptions.deepgram.punctuate`: 句読点を有効にする（オプション）
- `tools.media.audio.providerOptions.deepgram.smart_format`: スマートフォーマットを有効にする（オプション）

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

Deepgramオプション指定の例:

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

- 認証は標準のプロバイダー認証順序に従います。`DEEPGRAM_API_KEY` が最もシンプルな方法です。
- プロキシを使用する場合は `tools.media.audio.baseUrl` と `tools.media.audio.headers` でエンドポイントやヘッダーをオーバーライドしてください。
- 出力は他のプロバイダーと同じ音声ルール（サイズ上限、タイムアウト、文字起こし注入）に従います。
