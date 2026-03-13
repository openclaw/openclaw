---
summary: >-
  Zalo Personal plugin: QR login + messaging via native zca-js (plugin install +
  channel config + tool)
read_when:
  - You want Zalo Personal (unofficial) support in OpenClaw
  - You are configuring or developing the zalouser plugin
title: Zalo Personal Plugin
---

# Zalo Personal（外掛）

Zalo Personal 透過外掛支援 OpenClaw，使用原生 `zca-js` 來自動化一般 Zalo 使用者帳號。

> **警告：** 非官方的自動化可能導致帳號被停權或封鎖，請自行承擔風險使用。

## 命名

頻道 ID 使用 `zalouser`，以明確表示這是自動化 **個人 Zalo 使用者帳號**（非官方）。我們保留 `zalo` 以備未來可能的官方 Zalo API 整合。

## 執行位置

此外掛**在 Gateway 程序內執行**。

如果您使用遠端 Gateway，請在**執行 Gateway 的機器上安裝/設定**，然後重新啟動 Gateway。

不需要外部 `zca`/`openzca` CLI 執行檔。

## 安裝

### 選項 A：從 npm 安裝

```bash
openclaw plugins install @openclaw/zalouser
```

安裝完成後請重新啟動 Gateway。

### 選項 B：從本地資料夾安裝（開發用）

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

重新啟動 Gateway。

## 設定

頻道設定位於 `channels.zalouser`（非 `plugins.entries.*`）：

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

## CLI

```bash
openclaw channels login --channel zalouser
openclaw channels logout --channel zalouser
openclaw channels status --probe
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
openclaw directory peers list --channel zalouser --query "name"
```

## Agent 工具

工具名稱：`zalouser`

操作：`send`、`image`、`link`、`friends`、`groups`、`me`、`status`

頻道訊息操作也支援 `react` 作為訊息反應。
