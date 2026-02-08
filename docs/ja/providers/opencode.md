---
summary: "OpenClaw で OpenCode Zen（キュレーションされたモデル）を使用します"
read_when:
  - OpenCode Zen をモデルアクセスに使用したい場合
  - コーディングに適したモデルのキュレーションされたリストが必要な場合
title: "OpenCode Zen"
x-i18n:
  source_path: providers/opencode.md
  source_hash: b3b5c640ac32f317
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:51Z
---

# OpenCode Zen

OpenCode Zen は、コーディングエージェント向けに OpenCode チームが推奨する**キュレーションされたモデルの一覧**です。
API キーと `opencode` プロバイダーを使用する、オプションのホスト型モデルアクセス経路です。
Zen は現在ベータ版です。

## CLI セットアップ

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 設定スニペット

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 注記

- `OPENCODE_ZEN_API_KEY` もサポートされています。
- Zen にサインインし、請求情報を追加して、API キーをコピーします。
- OpenCode Zen はリクエスト単位で課金されます。詳細は OpenCode ダッシュボードを確認してください。
