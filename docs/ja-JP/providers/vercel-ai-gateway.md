---
read_when:
    - OpenClaw で Vercel AI Gateway ゲートウェイを使用したい場合
    - APIキーの環境変数や CLI 認証の選択肢が必要な場合
summary: Vercel AI Gateway ゲートウェイのセットアップ（認証 + モデル選択）
title: Vercel AI Gateway ゲートウェイ
x-i18n:
    generated_at: "2026-04-02T07:50:55Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f30768dc3db49708b25042d317906f7ad9a2c72b0fa03263bc04f5eefbf7a507
    source_path: providers/vercel-ai-gateway.md
    workflow: 15
---

# Vercel AI Gateway ゲートウェイ

[Vercel AI Gateway ゲートウェイ](https://vercel.com/ai-gateway)は、単一のエンドポイントを通じて数百のモデルにアクセスできる統合APIを提供します。

- プロバイダー: `vercel-ai-gateway`
- 認証: `AI_GATEWAY_API_KEY`
- API: Anthropic Messages 互換
- OpenClaw は Gateway ゲートウェイの `/v1/models` カタログを自動検出するため、`/models vercel-ai-gateway` には `vercel-ai-gateway/openai/gpt-5.4` などの現在のモデル参照が含まれます。

## クイックスタート

1. APIキーを設定します（推奨: Gateway ゲートウェイ用に保存）:

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

## 非対話型の例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 環境変数に関する注意

Gateway ゲートウェイがデーモン（launchd/systemd）として実行されている場合、`AI_GATEWAY_API_KEY` がそのプロセスで利用可能であることを確認してください（例: `~/.openclaw/.env` または `env.shellEnv` 経由）。

## モデルIDの省略形

OpenClaw は Vercel の Claude 省略形モデル参照を受け付け、ランタイムで正規化します:

- `vercel-ai-gateway/claude-opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4.6`
- `vercel-ai-gateway/opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4-6`
