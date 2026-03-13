---
summary: >-
  Zalo personal account support via native zca-js (QR login), capabilities, and
  configuration
read_when:
  - Setting up Zalo Personal for OpenClaw
  - Debugging Zalo Personal login or message flow
title: Zalo Personal
---

# Zalo 個人版（非官方）

狀態：實驗性。此整合透過 OpenClaw 內的原生 `zca-js` 自動化 **個人 Zalo 帳戶**。

> **警告：** 這是一個非官方的整合，可能會導致帳戶暫停或封禁。請自行承擔風險使用。

## Plugin required

Zalo Personal 作為一個插件發佈，並不與核心安裝包捆綁在一起。

- 透過 CLI 安裝: `openclaw plugins install @openclaw/zalouser`
- 或者從源碼檢出: `openclaw plugins install ./extensions/zalouser`
- 詳情: [插件](/tools/plugin)

不需要外部 `zca`/`openzca` CLI 二進位檔。

## 快速設置（初學者）

1. 安裝插件（請參見上方）。
2. 登入（QR，於 Gateway 機器上）：
   - `openclaw channels login --channel zalouser`
   - 使用 Zalo 行動應用程式掃描 QR 碼。
3. 啟用通道：

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

4. 重新啟動網關（或完成入門設定）。
5. DM 存取預設為配對；在第一次聯繫時批准配對碼。

## 這是什麼

- 完全在過程內執行，透過 `zca-js`。
- 使用原生事件監聽器接收進來的訊息。
- 直接通過 JS API 發送回覆（文字/媒體/連結）。
- 設計用於「個人帳戶」的使用案例，當 Zalo Bot API 不可用時。

## Naming

頻道 ID 是 `zalouser`，以明確表示這自動化了一個 **個人 Zalo 使用者帳號**（非官方）。我們保留 `zalo` 用於未來可能的官方 Zalo API 整合。

## 尋找 ID（目錄）

使用目錄 CLI 來發現對等端/群組及其 ID：

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limits

- 出站文字被分割為約 2000 個字元（Zalo 用戶端限制）。
- 串流預設為禁用。

## 存取控制 (DMs)

`channels.zalouser.dmPolicy` 支援: `pairing | allowlist | open | disabled` (預設: `pairing`)。

`channels.zalouser.allowFrom` 接受使用者 ID 或名稱。在入門過程中，名稱會透過插件的內部聯絡人查找功能解析為 ID。

Approve via:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 群組存取（選用）

- 預設: `channels.zalouser.groupPolicy = "open"`（允許群組）。當未設置時，使用 `channels.defaults.groupPolicy` 來覆蓋預設值。
- 使用以下方式限制為允許清單：
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（鍵應為穩定的群組 ID；名稱在啟動時會盡可能解析為 ID）
  - `channels.zalouser.groupAllowFrom`（控制哪些在允許群組中的發送者可以觸發機器人）
- 阻止所有群組: `channels.zalouser.groupPolicy = "disabled"`。
- 設定精靈可以提示輸入群組允許清單。
- 在啟動時，OpenClaw 會將允許清單中的群組/用戶名稱解析為 ID 並記錄映射。
- 群組允許清單的匹配預設為僅 ID。未解析的名稱在身份驗證時會被忽略，除非 `channels.zalouser.dangerouslyAllowNameMatching: true` 被啟用。
- `channels.zalouser.dangerouslyAllowNameMatching: true` 是一種緊急兼容模式，重新啟用可變群組名稱匹配。
- 如果 `groupAllowFrom` 未設置，執行時將回退到 `allowFrom` 進行群組發送者檢查。
- 發送者檢查適用於正常的群組消息和控制命令（例如 `/new`、`/reset`）。

[[BLOCK_1]]

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["1471383327500481391"],
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

### Group mention gating

- `channels.zalouser.groups.<group>.requireMention` 控制群組回覆是否需要提及。
- 解決順序：精確的群組 ID/名稱 -> 正規化的群組 slug -> `*` -> 預設 (`true`)。
- 這適用於允許的群組和開放群組模式。
- 授權的控制命令（例如 `/new`）可以繞過提及限制。
- 當因為需要提及而跳過群組訊息時，OpenClaw 將其儲存為待處理的群組歷史，並在下一個處理的群組訊息中包含它。
- 群組歷史限制預設為 `messages.groupChat.historyLimit`（備用 `50`）。您可以透過 `channels.zalouser.historyLimit` 為每個帳戶覆蓋此設定。

[[BLOCK_1]]

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "*": { allow: true, requireMention: true },
        "Work Chat": { allow: true, requireMention: false },
      },
    },
  },
}
```

## Multi-account

帳戶對應到 `zalouser` 在 OpenClaw 狀態中的個人資料。範例：

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

## 輸入、反應與交付確認

- OpenClaw 在發送回覆之前會先發送一個輸入事件（最佳努力）。
- 訊息反應動作 `react` 在頻道動作中支援 `zalouser`。
  - 使用 `remove: true` 來從訊息中移除特定的反應表情符號。
  - 反應語義：[反應](/tools/reactions)
- 對於包含事件元數據的進站訊息，OpenClaw 會發送已送達 + 已查看的確認（最佳努力）。

## 故障排除

**登入不會保持：**

- `openclaw channels status --probe`
- 重新登入: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`

**允許清單/群組名稱未解析：**

- 在 `allowFrom`/`groupAllowFrom`/`groups` 中使用數字 ID，或精確的朋友/群組名稱。

**升級自舊版 CLI 基礎設置：**

- 移除任何舊的外部 `zca` 處理假設。
- 該通道現在完全在 OpenClaw 中執行，無需外部 CLI 二進位檔。
