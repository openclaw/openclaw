---
summary: "透過 zca-cli (QR 登入) 支援 Zalo 個人帳號，包含功能與設定"
read_when:
  - 為 OpenClaw 設定 Zalo 個人帳號
  - 排查 Zalo 個人帳號登入或訊息流問題
title: "Zalo Personal"
---

# Zalo Personal (非官方)

狀態：實驗中。此整合透過 `zca-cli` 自動化 **Zalo 個人帳號**。

> **警告：** 這是一個非官方整合，可能導致帳號停權/封禁。請自行承擔風險。

## Plugin required

Zalo Personal 以外掛形式提供，未包含在核心安裝程式中。

- 透過 CLI 安裝：`openclaw plugins install @openclaw/zalouser`
- 或從原始碼安裝：`openclaw plugins install ./extensions/zalouser`
- 詳情：[Plugins](/tools/plugin)

## Prerequisite: zca-cli

Gateway 機器必須在 `PATH` 中提供 `zca` 執行檔。

- 驗證：`zca --version`
- 如果遺失，請安裝 zca-cli（參閱 `extensions/zalouser/README.md` 或上游 zca-cli 文件）。

## Quick setup (beginner)

1. 安裝外掛（見上方）。
2. 登入（QR Code，在 Gateway 機器上）：
   - `openclaw channels login --channel zalouser`
   - 使用 Zalo 行動應用程式掃描終端機中的 QR code。
3. 啟用頻道：

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

4. 重啟 Gateway（或完成新手導覽）。
5. 私訊存取預設為配對模式；在第一次接觸時核准配對碼。

## What it is

- 使用 `zca listen` 接收傳入訊息。
- 使用 `zca msg ...` 傳送回覆（文字/多媒體/連結）。
- 專為無法使用 Zalo Bot API 的「個人帳號」場景設計。

## Naming

頻道 ID 為 `zalouser`，以明確表示這是自動化 **Zalo 個人使用者帳號**（非官方）。我們將 `zalo` 保留給未來可能的官方 Zalo API 整合。

## Finding IDs (directory)

使用 directory CLI 來探索同儕/群組及其 ID：

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limits

- 傳出文字會被切分為約 2000 個字元（Zalo 用戶端限制）。
- 預設禁用區塊串流傳輸。

## Access control (DMs)

`channels.zalouser.dmPolicy` 支援：`pairing | allowlist | open | disabled`（預設：`pairing`）。
`channels.zalouser.allowFrom` 接受使用者 ID 或名稱。精靈會在可用時透過 `zca friend find` 將名稱解析為 ID。

核准方式：

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Group access (optional)

- 預設：`channels.zalouser.groupPolicy = "open"`（允許群組）。若未設定，請使用 `channels.defaults.groupPolicy` 覆蓋預設值。
- 使用白名單限制：
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（鍵名為群組 ID 或名稱）
- 封鎖所有群組：`channels.zalouser.groupPolicy = "disabled"`。
- 設定精靈可以提示輸入群組白名單。
- 啟動時，OpenClaw 會將白名單中的群組/使用者名稱解析為 ID 並記錄映射關係；未解析的項目將保留原始輸入內容。

範例：

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Multi-account

帳號映射至 zca 設定檔。範例：

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## 疑難排解

**找不到 `zca`：**

- 安裝 zca-cli 並確保其在 Gateway 程序可存取的 `PATH` 中。

**登入狀態未保存：**

- `openclaw channels status --probe`
- 重新登入：`openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
