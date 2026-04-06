---
read_when:
    - OpenCode Go カタログが必要な場合
    - Go ホストモデルのランタイムモデル参照が必要な場合
summary: 共有 OpenCode セットアップで OpenCode Go カタログを使用する
title: OpenCode Go
x-i18n:
    generated_at: "2026-04-02T08:58:35Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 8650af7c64220c14bab8c22472fff8bebd7abde253e972b6a11784ad833d321c
    source_path: providers/opencode-go.md
    workflow: 15
---

# OpenCode Go

OpenCode Go は [OpenCode](/providers/opencode) 内の Go カタログです。
Zen カタログと同じ `OPENCODE_API_KEY` を使用しますが、アップストリームのモデルごとのルーティングが正しく機能するよう、ランタイムプロバイダー ID は `opencode-go` を維持しています。

## サポートされているモデル

- `opencode-go/kimi-k2.5`
- `opencode-go/glm-5`
- `opencode-go/minimax-m2.5`

## CLI セットアップ

```bash
openclaw onboard --auth-choice opencode-go
# または非対話型
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 設定スニペット

```json5
{
  env: { OPENCODE_API_KEY: "YOUR_API_KEY_HERE" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "opencode-go/kimi-k2.5" } } },
}
```

## ルーティングの動作

モデル参照が `opencode-go/...` を使用している場合、OpenClaw はモデルごとのルーティングを自動的に処理します。

## 注意事項

- 共有オンボーディングとカタログの概要については [OpenCode](/providers/opencode) を参照してください。
- ランタイム参照は明示的に維持されます: Zen には `opencode/...`、Go には `opencode-go/...` を使用します。
