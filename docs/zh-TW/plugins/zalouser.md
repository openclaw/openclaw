---
summary: "Zalo 個人外掛程式：透過 zca-cli 進行 QR 登入 + 訊息傳送（外掛程式安裝 + 頻道設定 + CLI + 工具）"
read_when:
  - 您想在 OpenClaw 中獲得 Zalo 個人版（非官方）支援
  - 您正在設定或開發 zalouser 外掛程式
title: "Zalo 個人外掛程式"
---

# Zalo 個人版（外掛程式）

透過外掛程式在 OpenClaw 中支援 Zalo 個人版，使用 `zca-cli` 自動化普通的 Zalo 使用者帳號。

> **警告：** 非官方自動化可能導致帳號暫停/封鎖。請自行承擔風險。

## 命名

頻道 ID 為 `zalouser`，以明確表示這會自動化**個人 Zalo 使用者帳號**（非官方）。我們保留 `zalo` 以供未來可能與 Zalo 官方 API 整合使用。

## 執行位置

此外掛程式在 **Gateway 處理程序內部**執行。

如果您使用遠端 Gateway，請將其安裝/設定在**執行 Gateway 的機器上**，然後重新啟動 Gateway。

## 安裝

### 選項 A：從 npm 安裝

```bash
openclaw plugins install @openclaw/zalouser
```

之後重新啟動 Gateway。

### 選項 B：從本機檔案夾安裝（開發）

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

之後重新啟動 Gateway。

## 必要條件：zca-cli

Gateway 機器必須在 `PATH` 中包含 `zca`：

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

動作：`send`, `image`, `link`, `friends`, `groups`, `me`, `status`
