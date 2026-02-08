---
summary: "CLI 参照: `openclaw config` による設定値の取得／設定／解除"
read_when:
  - 設定を非対話的に読み取りまたは編集したい場合
title: "設定"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:00Z
---

# `openclaw config`

設定ヘルパー: パスを指定して値を取得／設定／解除します。サブコマンドを指定せずに実行すると、設定ウィザードが開きます（`openclaw configure` と同じです）。

## 例

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## パス

パスはドット表記またはブラケット表記を使用します。

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

特定のエージェントを対象にするには、エージェント一覧のインデックスを使用します。

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 値

値は可能な場合に JSON5 として解析され、そうでない場合は文字列として扱われます。JSON5 解析を必須にするには `--json` を使用してください。

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

編集後はゲートウェイを再起動してください。
