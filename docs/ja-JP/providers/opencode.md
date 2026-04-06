---
read_when:
    - OpenCodeホスト型のモデルアクセスを利用したい場合
    - ZenカタログとGoカタログを選択したい場合
summary: OpenCode ZenおよびGoカタログをOpenClawで使用する
title: OpenCode
x-i18n:
    generated_at: "2026-04-02T07:50:44Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9ffe65d152d1835163f9f5ae4cc966e29bd01a9dbb88187c24d149c960c8225d
    source_path: providers/opencode.md
    workflow: 15
---

# OpenCode

OpenCodeはOpenClawで2つのホスト型カタログを提供しています：

- `opencode/...` — **Zen**カタログ用
- `opencode-go/...` — **Go**カタログ用

両カタログは同じOpenCode APIキーを使用します。OpenClawはランタイムプロバイダーIDを分離して上流のモデルごとのルーティングが正しく機能するようにしていますが、オンボーディングやドキュメントでは1つのOpenCodeセットアップとして扱います。

## CLIセットアップ

### Zenカタログ

```bash
openclaw onboard --auth-choice opencode-zen
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

### Goカタログ

```bash
openclaw onboard --auth-choice opencode-go
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 設定スニペット

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## カタログ

### Zen

- ランタイムプロバイダー: `opencode`
- モデル例: `opencode/claude-opus-4-6`、`opencode/gpt-5.2`、`opencode/gemini-3-pro`
- 厳選されたOpenCodeマルチモデルプロキシを使いたい場合に最適

### Go

- ランタイムプロバイダー: `opencode-go`
- モデル例: `opencode-go/kimi-k2.5`、`opencode-go/glm-5`、`opencode-go/minimax-m2.5`
- OpenCodeホスト型のKimi/GLM/MiniMaxラインナップを使いたい場合に最適

## 注意事項

- `OPENCODE_ZEN_API_KEY`もサポートされています。
- セットアップ時に1つのOpenCodeキーを入力すると、両方のランタイムプロバイダーの認証情報が保存されます。
- OpenCodeにサインインし、請求情報を追加して、APIキーをコピーしてください。
- 請求やカタログの利用可否はOpenCodeダッシュボードから管理されます。
