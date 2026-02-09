---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway のセットアップ（認証 + モデル選択）"
read_when:
  - OpenClaw で Vercel AI Gateway を使用したい場合
  - API キーの環境変数または CLI 認証の選択が必要な場合
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) は、単一のエンドポイントを通じて数百のモデルにアクセスできる統合 API を提供します。

- プロバイダー: `vercel-ai-gateway`
- 認証: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages 互換

## クイックスタート

1. API キーを設定します（推奨: Gateway（ゲートウェイ）用に保存します）:

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. デフォルトのモデルを設定します:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## 非対話型の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 環境に関する注記

Gateway（ゲートウェイ）がデーモン（launchd/systemd）として実行される場合は、`AI_GATEWAY_API_KEY` がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` 内、または `env.shellEnv` 経由）。
