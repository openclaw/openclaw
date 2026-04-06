---
read_when:
    - 音声添付ファイルにDeepgramの音声テキスト変換を使用したいとき
    - Deepgramの簡単な設定例が必要なとき
summary: 受信ボイスノートのDeepgram文字起こし
title: Deepgram
x-i18n:
    generated_at: "2026-04-02T08:37:45Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: dabd1f6942c339fbd744fbf38040b6a663b06ddf4d9c9ee31e3ac034de9e79d9
    source_path: providers/deepgram.md
    workflow: 15
---

# Deepgram（音声文字起こし）

Deepgramは音声テキスト変換APIです。OpenClawでは、`tools.media.audio` を介した**受信音声/ボイスノートの文字起こし**に使用されます。

有効にすると、OpenClawは音声ファイルをDeepgramにアップロードし、文字起こしテキストを返信パイプラインに注入します（`{{Transcript}}` + `[Audio]` ブロック）。これは**ストリーミングではなく**、事前録音された文字起こしエンドポイントを使用します。

Webサイト: [https://deepgram.com](https://deepgram.com)  
ドキュメント: [https://developers.deepgram.com](https://developers.deepgram.com)

## クイックスタート

1. APIキーを設定します：

```
DEEPGRAM_API_KEY=dg_...
```

2. プロバイダーを有効にします：

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

- `model`：DeepgramモデルID（デフォルト: `nova-3`）
- `language`：言語ヒント（任意）
- `tools.media.audio.providerOptions.deepgram.detect_language`：言語検出を有効にする（任意）
- `tools.media.audio.providerOptions.deepgram.punctuate`：句読点を有効にする（任意）
- `tools.media.audio.providerOptions.deepgram.smart_format`：スマートフォーマットを有効にする（任意）

言語指定の例：

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

Deepgramオプション付きの例：

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

- 認証は標準のプロバイダー認証順序に従います。`DEEPGRAM_API_KEY` が最も簡単な方法です。
- プロキシを使用する場合は、`tools.media.audio.baseUrl` と `tools.media.audio.headers` でエンドポイントやヘッダーをオーバーライドしてください。
- 出力は他のプロバイダーと同じ音声ルール（サイズ上限、タイムアウト、文字起こし注入）に従います。
