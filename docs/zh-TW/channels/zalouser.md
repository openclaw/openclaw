---
summary: "透過 zca-cli（QR 登入）支援 Zalo 個人帳號、功能與設定"
read_when:
  - 為 OpenClaw 設定 Zalo Personal
  - 偵錯 Zalo Personal 登入或訊息流程
title: "Zalo Personal"
x-i18n:
  source_path: channels/zalouser.md
  source_hash: ede847ebe6272256
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:10Z
---

# Zalo Personal（非官方）

狀態：實驗性。此整合會自動化 **Zalo 個人帳號**，透過 `zca-cli`。

> **警告：** 這是非官方整合，可能導致帳號被停權／封鎖。請自行承擔風險。

## 需要的外掛

Zalo Personal 以外掛形式提供，未包含在核心安裝中。

- 透過 CLI 安裝：`openclaw plugins install @openclaw/zalouser`
- 或從原始碼檢出安裝：`openclaw plugins install ./extensions/zalouser`
- 詳情：[Plugins](/tools/plugin)

## 先決條件：zca-cli

Gateway 閘道器 主機必須在 `PATH` 中可用 `zca` 二進位檔。

- 驗證：`zca --version`
- 若缺少，請安裝 zca-cli（請參閱 `extensions/zalouser/README.md` 或上游 zca-cli 文件）。

## 快速設定（新手）

1. 安裝外掛（見上方）。
2. 登入（QR，在 Gateway 閘道器 主機上）：
   - `openclaw channels login --channel zalouser`
   - 使用 Zalo 行動應用程式掃描終端機中的 QR Code。
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

4. 重新啟動 Gateway 閘道器（或完成入門引導）。
5. 私訊存取預設為配對；首次聯繫時核准配對碼。

## 這是什麼

- 使用 `zca listen` 接收傳入訊息。
- 使用 `zca msg ...` 傳送回覆（文字／媒體／連結）。
- 專為無法使用 Zalo Bot API 的「個人帳號」使用情境設計。

## 命名

頻道 id 為 `zalouser`，以明確表示這會自動化 **Zalo 個人使用者帳號**（非官方）。我們保留 `zalo`，以供未來可能的官方 Zalo API 整合。

## 尋找 ID（目錄）

使用目錄 CLI 探索對象／群組及其 ID：

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 限制

- 傳出文字會切分為約 2000 個字元（Zalo 用戶端限制）。
- 串流預設為封鎖。

## 存取控制（私訊）

`channels.zalouser.dmPolicy` 支援：`pairing | allowlist | open | disabled`（預設：`pairing`）。
`channels.zalouser.allowFrom` 接受使用者 ID 或名稱。精靈在可用時會透過 `zca friend find` 將名稱解析為 ID。

核准方式：

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 群組存取（選用）

- 預設：`channels.zalouser.groupPolicy = "open"`（允許群組）。在未設定時，使用 `channels.defaults.groupPolicy` 覆寫預設值。
- 使用允許清單限制：
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（鍵值為群組 ID 或名稱）
- 封鎖所有群組：`channels.zalouser.groupPolicy = "disabled"`。
- 設定精靈可提示輸入群組允許清單。
- 啟動時，OpenClaw 會將允許清單中的群組／使用者名稱解析為 ID 並記錄對應關係；無法解析的項目會保留原樣。

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

帳號會對應到 zca 設定檔。範例：

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

- 安裝 zca-cli，並確保對 Gateway 閘道器 程序而言，它位於 `PATH`。

**登入無法持續：**

- `openclaw channels status --probe`
- 重新登入：`openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
