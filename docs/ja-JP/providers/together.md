---
read_when:
    - Together AIをOpenClawで使用したい場合
    - APIキーの環境変数またはCLI認証オプションが必要な場合
summary: Together AIのセットアップ（認証 + モデル選択）
title: Together AI
x-i18n:
    generated_at: "2026-04-02T07:50:56Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0d0e1136157f9599c46ac2f332cc9a9e55de99870282855002a453f773c6e350
    source_path: providers/together.md
    workflow: 15
---

# Together AI

[Together AI](https://together.ai)は、Llama、DeepSeek、Kimiなどの主要なオープンソースモデルにユニファイドAPIを通じてアクセスを提供します。

- プロバイダー: `together`
- 認証: `TOGETHER_API_KEY`
- API: OpenAI互換

## クイックスタート

1. APIキーを設定します（推奨: Gateway ゲートウェイ用に保存）:

```bash
openclaw onboard --auth-choice together-api-key
```

2. デフォルトモデルを設定します:

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.5" },
    },
  },
}
```

## 非対話型の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

これにより、`together/moonshotai/Kimi-K2.5`がデフォルトモデルとして設定されます。

## 環境に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行されている場合、`TOGETHER_API_KEY`がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env`に記載するか、`env.shellEnv`経由で設定）。

## 利用可能なモデル

Together AIは多くの人気オープンソースモデルへのアクセスを提供します:

- **GLM 4.7 Fp8** - 200Kコンテキストウィンドウを持つデフォルトモデル
- **Llama 3.3 70B Instruct Turbo** - 高速で効率的な指示追従
- **Llama 4 Scout** - 画像理解を備えたビジョンモデル
- **Llama 4 Maverick** - 高度なビジョンと推論
- **DeepSeek V3.1** - 強力なコーディング・推論モデル
- **DeepSeek R1** - 高度な推論モデル
- **Kimi K2 Instruct** - 262Kコンテキストウィンドウを持つ高性能モデル

すべてのモデルは標準的なチャット補完をサポートしており、OpenAI API互換です。
