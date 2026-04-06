---
read_when:
    - OpenClawでGroqを使用したい場合
    - APIキーの環境変数やCLI認証の選択肢を知りたい場合
summary: Groqのセットアップ（認証 + モデル選択）
title: Groq
x-i18n:
    generated_at: "2026-04-02T08:38:04Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 00e494781af4c38c8b754ee8fe3cfe1c6fc485d552910db991d99d408b27ca55
    source_path: providers/groq.md
    workflow: 15
---

# Groq

[Groq](https://groq.com)は、カスタムLPUハードウェアを使用してオープンソースモデル（Llama、Gemma、Mistralなど）の超高速推論を提供します。OpenClawはGroqのOpenAI互換APIを通じて接続します。

- プロバイダー: `groq`
- 認証: `GROQ_API_KEY`
- API: OpenAI互換

## クイックスタート

1. [console.groq.com/keys](https://console.groq.com/keys)からAPIキーを取得します。

2. APIキーを設定します：

```bash
export GROQ_API_KEY="gsk_..."
```

3. デフォルトモデルを設定します：

```json5
{
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## 設定ファイルの例

```json5
{
  env: { GROQ_API_KEY: "gsk_..." },
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## 音声文字起こし

Groqは高速なWhisperベースの音声文字起こしも提供しています。メディア理解プロバイダーとして設定すると、OpenClawはGroqの`whisper-large-v3-turbo`モデルを使用して音声メッセージを文字起こしします。

```json5
{
  media: {
    understanding: {
      audio: {
        models: [{ provider: "groq" }],
      },
    },
  },
}
```

## 環境に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行されている場合、`GROQ_API_KEY`がそのプロセスで利用可能であることを確認してください（例：`~/.openclaw/.env`または`env.shellEnv`経由）。

## 利用可能なモデル

Groqのモデルカタログは頻繁に更新されます。`openclaw models list | grep groq`を実行して現在利用可能なモデルを確認するか、[console.groq.com/docs/models](https://console.groq.com/docs/models)を参照してください。

よく使われるモデル：

- **Llama 3.3 70B Versatile** - 汎用、大きなコンテキスト
- **Llama 3.1 8B Instant** - 高速、軽量
- **Gemma 2 9B** - コンパクト、効率的
- **Mixtral 8x7B** - MoEアーキテクチャ、強力な推論

## リンク

- [Groqコンソール](https://console.groq.com)
- [APIドキュメント](https://console.groq.com/docs)
- [モデル一覧](https://console.groq.com/docs/models)
- [料金](https://groq.com/pricing)
