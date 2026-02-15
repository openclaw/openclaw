---
summary: "Zalo 個人版插件：QR 碼登入 + 透過 zca-cli 傳送訊息（插件安裝 + 頻道設定 + CLI + 工具）"
read_when:
  - 您想在 OpenClaw 中使用 Zalo 個人版（非官方）支援
  - 您正在設定或開發 zalouser 插件
title: "Zalo 個人版插件"
---

# Zalo 個人版 (插件)

透過插件為 OpenClaw 提供 Zalo 個人版支援，使用 `zca-cli` 自動化操作一般的 Zalo 使用者帳號。

> **警告：** 非官方自動化可能導致帳號被停權或封鎖。請自行承擔風險。

## 命名

頻道 ID 為 `zalouser`，以明確表示這是自動化操作 **個人 Zalo 使用者帳號**（非官方）。我們保留 `zalo` 一詞，以備未來可能的官方 Zalo API 整合之用。

## 執行位置

此插件在 **Gateway 程序內部** 執行。

如果您使用遠端 Gateway，請在 **執行 Gateway 的機器** 上安裝/設定，然後重啟 Gateway。

## 安裝

### 選項 A：從 npm 安裝

```bash
openclaw plugins install @openclaw/zalouser
```

完成後請重啟 Gateway。

### 選項 B：從本地資料夾安裝（開發環境）

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

完成後請重啟 Gateway。

## 前提條件：zca-cli

執行 Gateway 的機器必須將 `zca` 加入 `PATH`：

```bash
zca --version
```

## 設定

頻道設定位於 `channels.zalouser` 下（而非 `plugins.entries.*`）：

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

## 智慧代理工具

工具名稱：`zalouser`

操作：`send`, `image`, `link`, `friends`, `groups`, `me`, `status`
