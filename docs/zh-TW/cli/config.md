---
summary: "CLI 參考文件：`openclaw config`（以 get/set/unset 取得／設定／取消設定值）"
read_when:
  - 你想要以非互動方式讀取或編輯設定
title: "config"
---

# `openclaw config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `openclaw configure`).

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
Use `--json` to require JSON5 parsing.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
