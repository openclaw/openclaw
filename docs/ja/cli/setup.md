---
summary: "「openclaw setup」（設定とワークスペースを初期化）の CLI リファレンス"
read_when:
  - "フルのオンボーディングウィザードを使用せずに初回セットアップを行う場合"
  - "デフォルトのワークスペースパスを設定したい場合"
title: "セットアップ"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:11Z
---

# `openclaw setup`

`~/.openclaw/openclaw.json` とエージェントのワークスペースを初期化します。

関連情報:

- はじめに: [Getting started](/start/getting-started)
- ウィザード: [Onboarding](/start/onboarding)

## 例

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

setup 経由でウィザードを実行するには:

```bash
openclaw setup --wizard
```
