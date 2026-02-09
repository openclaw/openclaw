---
summary: "Zalo Personal 外掛：QR 登入 + 透過 zca-cli 傳訊（外掛安裝 + 頻道設定 + CLI + 工具）"
read_when:
  - 你想在 OpenClaw 中使用 Zalo Personal（非官方）支援
  - 你正在設定或開發 zalouser 外掛
title: "Zalo Personal 外掛"
---

# Zalo Personal（外掛）

透過外掛為 OpenClaw 提供 Zalo Personal 支援，使用 `zca-cli` 自動化一般的 Zalo 使用者帳號。

> **警告：** 非官方自動化可能導致帳號停權/封鎖。 使用風險請自行承擔。

## 命名

頻道 id 為 `zalouser`，以明確表示這是自動化 **個人 Zalo 使用者帳號**（非官方）。我們保留 `zalo`，以供未來可能的官方 Zalo API 整合使用。 We keep `zalo` reserved for a potential future official Zalo API integration.

## Where it runs

This plugin runs **inside the Gateway process**.

If you use a remote Gateway, install/configure it on the **machine running the Gateway**, then restart the Gateway.

## 安裝

### 選項 A：從 npm 安裝

```bash
openclaw plugins install @openclaw/zalouser
```

之後重新啟動 Gateway 閘道器。

### 選項 B：從本機資料夾安裝（開發用）

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

之後重新啟動 Gateway 閘道器。

## 先決條件：zca-cli

Gateway 閘道器 機器必須在 `PATH` 上安裝 `zca`：

```bash
zca --version
```

## 設定

頻道設定位於 `channels.zalouser` 之下（不是 `plugins.entries.*`）：

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

## 代理程式工具

工具名稱：`zalouser`

動作：`send`、`image`、`link`、`friends`、`groups`、`me`、`status`
