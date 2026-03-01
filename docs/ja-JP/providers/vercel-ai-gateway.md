---
title: "Vercel AI Gateway"
summary: "Vercel AI Gatewayのセットアップ（認証とモデル選択）"
read_when:
  - OpenClawでVercel AI Gatewayを使いたい場合
  - APIキーの環境変数またはCLI認証の選択が必要な場合
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) は単一のエンドポイントを通じて数百のモデルにアクセスする統合APIを提供しています。

- プロバイダー: `vercel-ai-gateway`
- 認証: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages互換

## クイックスタート

1. APIキーを設定します（推奨: Gatewayに保存）:

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. デフォルトモデルを設定します:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## 非インタラクティブの例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 環境に関する注意

Gatewayがデーモン（launchd/systemd）として実行されている場合、そのプロセスで `AI_GATEWAY_API_KEY` が利用可能であることを確認してください（例: `~/.openclaw/.env` または `env.shellEnv` 経由）。

## モデルIDの短縮形

OpenClawはVercel Claudeの短縮モデル参照を受け入れ、実行時に正規化します:

- `vercel-ai-gateway/claude-opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4.6`
- `vercel-ai-gateway/opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4-6`
