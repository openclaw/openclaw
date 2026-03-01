---
summary: "`openclaw config` のCLIリファレンス（設定値のget/set/unset）"
read_when:
  - 非対話的に設定を読み書きしたい場合
title: "config"
---

# `openclaw config`

設定ヘルパー：パスによる値のget/set/unsetを行います。サブコマンドなしで実行すると、
設定ウィザードが開きます（`openclaw configure` と同じ）。

## 使用例

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## パス

パスはドット記法またはブラケット記法を使用します：

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

特定のエージェントを指定するには、エージェントリストのインデックスを使用します：

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 値

値は可能な場合JSON5としてパースされます。それ以外の場合は文字列として扱われます。
JSON5パースを必須にするには `--strict-json` を使用します。`--json` はレガシーエイリアスとして引き続きサポートされています。

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --strict-json
openclaw config set channels.whatsapp.groups '["*"]' --strict-json
```

編集後はGatewayを再起動してください。
