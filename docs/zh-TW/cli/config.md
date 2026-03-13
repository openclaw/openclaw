---
summary: CLI reference for `openclaw config` (get/set/unset/file/validate)
read_when:
  - You want to read or edit config non-interactively
title: config
---

# `openclaw config`

Config helpers: 透過路徑獲取/設定/取消設定/驗證值並列印當前的設定檔案。若不帶子命令執行，將開啟設定精靈（與 `openclaw configure` 相同）。

## Examples

```bash
openclaw config file
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
openclaw config validate
openclaw config validate --json
```

## Paths

路徑使用點或括號表示法：

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

使用代理列表索引來針對特定代理：

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

值會在可能的情況下解析為 JSON5；否則將被視為字串。使用 `--strict-json` 來要求 JSON5 解析。`--json` 仍然作為舊版別名被支援。

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --strict-json
openclaw config set channels.whatsapp.groups '["*"]' --strict-json
```

## 子指令

- `config file`: 列印活動設定檔案路徑（從 `OPENCLAW_CONFIG_PATH` 或預設位置解析而來）。

編輯後請重新啟動網關。

## Validate

在不啟動網關的情況下，驗證當前設定是否符合活動架構。

```bash
openclaw config validate
openclaw config validate --json
```
