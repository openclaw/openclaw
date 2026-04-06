---
read_when:
    - OpenClaw で Mistral モデルを使用したい場合
    - Mistral API キーのオンボーディングとモデル参照が必要な場合
summary: OpenClaw で Mistral モデルと Voxtral 文字起こしを使用する
title: Mistral
x-i18n:
    generated_at: "2026-04-02T08:57:56Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4f3efe060cbaeb14e20439ade040e57d27e7d98fb9dd06e657f6a69ae808f24f
    source_path: providers/mistral.md
    workflow: 15
---

# Mistral

OpenClaw はテキスト/画像モデルルーティング（`mistral/...`）と、メディア理解における Voxtral を使った音声文字起こしの両方で Mistral をサポートしています。
Mistral はメモリエンベディング（`memorySearch.provider = "mistral"`）にも使用できます。

## CLI セットアップ

```bash
openclaw onboard --auth-choice mistral-api-key
# または非対話型
openclaw onboard --mistral-api-key "$MISTRAL_API_KEY"
```

## 設定スニペット（LLM プロバイダー）

```json5
{
  env: { MISTRAL_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
}
```

## 設定スニペット（Voxtral による音声文字起こし）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

## 注意事項

- Mistral の認証には `MISTRAL_API_KEY` を使用します。
- プロバイダーのベース URL はデフォルトで `https://api.mistral.ai/v1` です。
- オンボーディングのデフォルトモデルは `mistral/mistral-large-latest` です。
- Mistral のメディア理解デフォルト音声モデルは `voxtral-mini-latest` です。
- メディア文字起こしのパスは `/v1/audio/transcriptions` を使用します。
- メモリエンベディングのパスは `/v1/embeddings` を使用します（デフォルトモデル: `mistral-embed`）。
