---
summary: "透過 zca-cli（QR 登入）、功能和設定，支援 Zalo 個人帳號"
read_when:
  - 為 OpenClaw 設定 Zalo 個人帳號
  - 偵錯 Zalo 個人登入或訊息流程
title: "Zalo 個人帳號"
---

# Zalo 個人帳號 (非官方)

狀態：實驗性質。此整合透過 `zca-cli` 自動化 **Zalo 個人帳號**。

> **警告：** 這是一個非官方整合，可能會導致帳號暫停/封鎖。請自行承擔風險使用。

## 所需外掛程式

Zalo 個人帳號以外掛程式形式提供，並未與核心安裝程式捆綁。

- 透過 CLI 安裝：`openclaw plugins install @openclaw/zalouser`
- 或從原始碼結帳安裝：`openclaw plugins install ./extensions/zalouser`
- 詳細資訊：[外掛程式](/tools/plugin)

## 必要條件：zca-cli

Gateway 機器必須在 `PATH` 中提供 `zca` 二進位檔。

- 驗證：`zca --version`
- 如果缺少，請安裝 zca-cli（請參閱 `extensions/zalouser/README.md` 或上游 zca-cli 文件）。

## 快速設定 (初學者)

1.  安裝外掛程式（請參閱上方）。
2.  登入（QR 碼，在 Gateway 機器上）：
    - `openclaw channels login --channel zalouser`
    - 使用 Zalo 行動應用程式掃描終端機中的 QR 碼。
3.  啟用頻道：

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

4.  重新啟動 Gateway（或完成新手導覽）。
5.  私訊存取預設為配對；初次聯絡時請批准配對碼。

## 內容說明

- 使用 `zca listen` 接收傳入訊息。
- 使用 `zca msg ...` 傳送回覆（文字/媒體/連結）。
- 專為 Zalo Bot API 不可用的「個人帳號」使用案例設計。

## 命名

頻道 ID 為 `zalouser`，以明確表示這會自動化 **Zalo 個人使用者帳號** (非官方)。我們保留 `zalo` 以供未來潛在的官方 Zalo API 整合使用。

## 尋找 ID (目錄)

使用目錄 CLI 探索對等方/群組及其 ID：

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 限制

- 出站文字會分塊處理為約 2000 個字元（Zalo 用戶端限制）。
- 串流傳輸預設為區塊串流傳輸。

## 存取控制 (私訊)

`channels.zalouser.dmPolicy` 支援：`pairing | allowlist | open | disabled` (預設值：`pairing`)。
`channels.zalouser.allowFrom` 接受使用者 ID 或名稱。精靈會在可用時透過 `zca friend find` 將名稱解析為 ID。

透過以下方式批准：

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 群組存取 (可選)

- 預設值：`channels.zalouser.groupPolicy = "open"` (允許群組)。在未設定時，使用 `channels.defaults.groupPolicy` 覆寫預設值。
- 使用允許列表限制：
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (鍵為群組 ID 或名稱)
- 封鎖所有群組：`channels.zalouser.groupPolicy = "disabled"`。
- 設定精靈可以提示群組允許列表。
- 在啟動時，OpenClaw 會將允許列表中的群組/使用者名稱解析為 ID，並記錄映射；未解析的項目將保持原樣。

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

## 多帳號

帳號映射到 zca 設定檔。範例：

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

- 安裝 zca-cli 並確保它在 Gateway 程序的 `PATH` 中。

**登入無法持續：**

- `openclaw channels status --probe`
- 重新登入：`openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
