---
summary: "Proposal: long-term command authorization model for ACP-bound conversations"
read_when:
  - >-
    Designing native command auth behavior in Telegram/Discord ACP-bound
    channels/topics
title: ACP Bound Command Authorization (Proposal)
---

# ACP 邊界命令授權（提案）

狀態：提議中，**尚未實作**。

本文件描述了一種針對 ACP 綁定對話中的原生命令的長期授權模型。這是一項實驗提案，並不取代當前的生產行為。

對於已實作的行為，請參閱來源和測試：

- `src/telegram/bot-native-commands.ts`
- `src/discord/monitor/native-command.ts`
- `src/auto-reply/reply/commands-core.ts`

## 問題

今天我們有特定命令的檢查（例如 `/new` 和 `/reset`），這些檢查需要在 ACP 綁定的頻道/主題內運作，即使允許清單是空的。這解決了當前的使用者體驗問題，但基於命令名稱的例外情況無法擴充。

## Long-term shape

將命令授權從臨時處理邏輯移至命令元數據以及共享的政策評估器。

### 1) 將認證政策元資料新增至指令定義

每個命令定義應該聲明一個授權政策。範例格式：

```ts
type CommandAuthPolicy =
  | { mode: "owner_or_allowlist" } // default, current strict behavior
  | { mode: "bound_acp_or_owner_or_allowlist" } // allow in explicitly bound ACP conversations
  | { mode: "owner_only" };
```

`/new` 和 `/reset` 將會使用 `bound_acp_or_owner_or_allowlist`。大多數其他命令將保持 `owner_or_allowlist`。

### 2) 在各個通道之間共享一個評估器

介紹一個幫助器，用於評估命令授權，使用：

- command policy metadata
- sender authorization state
- resolved conversation binding state

Telegram 和 Discord 的原生處理程序應該呼叫相同的輔助函數，以避免行為偏差。

### 3) 使用綁定匹配作為繞過邊界

當政策允許綁定的 ACP 繞過時，僅在為當前對話解析出設定的綁定匹配後授權（而不僅僅是因為當前會話金鑰看起來像 ACP）。

這樣可以保持邊界明確，並最小化意外擴充的情況。

## 為什麼這樣更好

- 可擴充至未來的指令，而無需增加更多的指令名稱條件。
- 在各個通道中保持行為一致。
- 通過要求明確的綁定匹配來保護當前的安全模型。
- 將允許清單視為可選的強化措施，而非普遍要求。

## Rollout plan (future)

1. 將命令授權政策欄位新增至命令註冊類型和命令資料中。
2. 實作共享評估器並遷移 Telegram 和 Discord 原生處理程序。
3. 將 `/new` 和 `/reset` 移至以元資料驅動的政策中。
4. 根據政策模式和通道表面新增測試。

## 非目標

- 此提案不會改變 ACP 會話的生命週期行為。
- 此提案不需要對所有 ACP 綁定的命令使用允許清單。
- 此提案不會改變現有的路由綁定語義。

## Note

此提案是有意為之，並不刪除或取代現有的實驗文件。
