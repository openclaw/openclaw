---
summary: "OpenCode Zen（厳選されたモデル）をOpenClawで使用する"
read_when:
  - モデルアクセスにOpenCode Zenを使いたい場合
  - コーディングに適した厳選モデルリストが欲しい場合
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zenは、OpenCodeチームがコーディングエージェント向けに推奨する**厳選されたモデルリスト**です。APIキーと `opencode` プロバイダーを使用するオプションのホスト型モデルアクセスパスです。Zenは現在ベータ版です。

## CLIセットアップ

```bash
openclaw onboard --auth-choice opencode-zen
# または非インタラクティブ
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 設定スニペット

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 注意事項

- `OPENCODE_ZEN_API_KEY` もサポートされています。
- Zenにサインインし、請求情報を追加してAPIキーをコピーしてください。
- OpenCode ZenはリクエストごとにBillingsを行います。詳細はOpenCodeダッシュボードを確認してください。
