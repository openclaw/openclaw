---
read_when:
    - OpenClawでVolcano EngineまたはDoubaoモデルを使用したい場合
    - Volcengine APIキーのセットアップが必要な場合
summary: Volcano Engineのセットアップ（Doubaoモデル、汎用+コーディングエンドポイント）
title: Volcengine (Doubao)
x-i18n:
    generated_at: "2026-04-02T07:51:09Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 67cad03eb5ec77e8cc07b0496b196d3b4a475b7eaac13f592045a98d443b3895
    source_path: providers/volcengine.md
    workflow: 15
---

# Volcengine (Doubao)

Volcengineプロバイダーは、DoubaoモデルおよびVolcano Engineでホストされるサードパーティモデルへのアクセスを提供し、汎用とコーディングのワークロード用に別々のエンドポイントがあります。

- プロバイダー: `volcengine`（汎用）+ `volcengine-plan`（コーディング）
- 認証: `VOLCANO_ENGINE_API_KEY`
- API: OpenAI互換

## クイックスタート

1. APIキーを設定します:

```bash
openclaw onboard --auth-choice volcengine-api-key
```

2. デフォルトモデルを設定します:

```json5
{
  agents: {
    defaults: {
      model: { primary: "volcengine-plan/ark-code-latest" },
    },
  },
}
```

## 非対話型の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"
```

## プロバイダーとエンドポイント

| プロバイダー      | エンドポイント                            | 用途           |
| ----------------- | ----------------------------------------- | -------------- |
| `volcengine`      | `ark.cn-beijing.volces.com/api/v3`        | 汎用モデル     |
| `volcengine-plan` | `ark.cn-beijing.volces.com/api/coding/v3` | コーディングモデル |

両方のプロバイダーは単一のAPIキーで設定されます。セットアップ時に両方が自動的に登録されます。

## 利用可能なモデル

- **doubao-seed-1-8** - Doubao Seed 1.8（汎用、デフォルト）
- **doubao-seed-code-preview** - Doubaoコーディングモデル
- **ark-code-latest** - コーディングプランのデフォルト
- **Kimi K2.5** - Volcano Engine経由のMoonshot AI
- **GLM-4.7** - Volcano Engine経由のGLM
- **DeepSeek V3.2** - Volcano Engine経由のDeepSeek

ほとんどのモデルはテキスト+画像入力に対応しています。コンテキストウィンドウは128Kから256Kトークンの範囲です。

## 環境に関する注意

Gateway がデーモン（launchd/systemd）として実行されている場合、`VOLCANO_ENGINE_API_KEY`がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env`または`env.shellEnv`経由）。
