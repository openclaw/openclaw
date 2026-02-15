---
summary: "用於 `openclaw config` (取得/設定/取消設定 設定值) 的 CLI 參考"
read_when:
  - 您想以非互動方式讀取或編輯設定
title: "config"
---

# `openclaw config`

設定輔助程式：透過路徑取得/設定/取消設定值。不帶子命令執行可開啟設定精靈 (與 `openclaw configure` 相同)。

## 範例

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## 路徑

路徑使用點或方括號表示法：

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

值會盡可能解析為 JSON5；否則將視為字串。使用 `--json` 要求 JSON5 解析。

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

編輯後請重新啟動 Gateway。
