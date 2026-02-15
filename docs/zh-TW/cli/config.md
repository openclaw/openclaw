---
summary: "openclaw config 的 CLI 參考文件（獲取/設定/取消設定值）"
read_when:
  - 當您想要以非互動方式讀取或編輯設定時
title: "config"
---

# `openclaw config`

設定小幫手：透過路徑獲取、設定或取消設定值。執行不帶子指令的命令可開啟設定精靈（與 `openclaw configure` 相同）。

## 範例

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## 路徑

路徑使用點號（dot）或方括號（bracket）標記法：

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

使用智慧代理列表索引來指定特定的智慧代理：

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 值

值在可行時會被解析為 JSON5；否則將被視為字串。
使用 `--json` 以要求進行 JSON5 解析。

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

編輯後請重啟 Gateway。
