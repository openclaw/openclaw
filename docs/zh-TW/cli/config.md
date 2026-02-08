---
summary: "CLI 參考文件：`openclaw config`（以 get/set/unset 取得／設定／取消設定值）"
read_when:
  - 你想要以非互動方式讀取或編輯設定
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:10Z
---

# `openclaw config`

設定輔助工具：依路徑取得／設定／取消設定值。未指定子指令執行時，會開啟設定精靈（同 `openclaw configure`）。

## Examples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Paths

路徑可使用點記法或括號記法：

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

使用代理程式清單索引以指定特定代理程式：

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

在可行時，值會以 JSON5 解析；否則視為字串。使用 `--json` 以要求進行 JSON5 解析。

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

編輯後請重新啟動 Gateway 閘道器。
