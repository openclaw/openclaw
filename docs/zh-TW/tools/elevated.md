---
summary: "高階執行模式與 /elevated 指令"
read_when:
  - 調整高階模式預設值、允許清單或斜線指令行為時
title: "高階模式"
---

# 高階模式 (/elevated 指令)

## 功能說明

- `/elevated on` 在 Gateway 主機上執行並保留 exec 審核（與 `/elevated ask` 相同）。
- `/elevated full` 在 Gateway 主機上執行 **並且** 自動核准 exec（跳過 exec 審核）。
- `/elevated ask` 在 Gateway 主機上執行但保留 exec 審核（與 `/elevated on` 相同）。
- `on`/`ask` **不會** 強制設定 `exec.security=full`；原先設定的安全性/詢問策略仍然有效。
- 僅在智慧代理被 **沙箱隔離** 時才會改變行為（否則 exec 本身就在主機上執行）。
- 指令形式：`/elevated on|off|ask|full`, `/elev on|off|ask|full`。
- 僅接受 `on|off|ask|full`；任何其他輸入將回傳提示且不會改變狀態。

## 控制範圍 (以及非控制範圍)

- **可用性檢查點**：`tools.elevated` 是全域基準。`agents.list[].tools.elevated` 可以進一步限制每個智慧代理的高階權限（兩者都必須允許）。
- **工作階段狀態**：`/elevated on|off|ask|full` 為當前的工作階段金鑰設定高階層級。
- **內聯指令**：訊息中的 `/elevated on|ask|full` 僅適用於該則訊息。
- **群組**：在群組聊天中，只有在智慧代理被標記（mention）時，高階指令才會被採納。繞過標記需求的「僅含指令訊息」會被視為已標記。
- **主機執行**：高階模式會強制 `exec` 在 Gateway 主機上執行；`full` 同時會設定 `security=full`。
- **審核**：`full` 會跳過 exec 審核；`on`/`ask` 則在允許清單/詢問規則要求時遵循審核流程。
- **非沙箱隔離智慧代理**：對執行位置無影響；僅影響檢查、日誌紀錄與狀態。
- **工具策略仍然適用**：如果 `exec` 被工具策略拒絕，則無法使用高階模式。
- **與 `/exec` 獨立**：`/exec` 是為已授權傳送者調整每個工作階段的預設值，且不需要高階模式。

## 解析順序

1. 訊息中的內聯指令（僅適用於該則訊息）。
2. 工作階段覆寫（透過傳送「僅含指令」的訊息設定）。
3. 全域預設值（設定檔中的 `agents.defaults.elevatedDefault`）。

## 設定工作階段預設值

- 傳送一則 **僅包含** 指令的訊息（允許空格），例如 `/elevated full`。
- 系統會傳送確認回覆（`Elevated mode set to full...` / `Elevated mode disabled.`）。
- 如果高階存取被停用，或者傳送者不在核准的允許清單中，該指令會回傳提供指引的錯誤訊息，且不會改變工作階段狀態。
- 傳送不帶參數的 `/elevated`（或 `/elevated:`）可查看目前的高階層級。

## 可用性 + 允許清單

- 功能開關：`tools.elevated.enabled`（即使程式碼支援，預設也可以透過設定關閉）。
- 傳送者允許清單：`tools.elevated.allowFrom` 搭配各個供應商的允許清單（例如 `discord`, `whatsapp`）。
- 智慧代理檢查點：`agents.list[].tools.elevated.enabled`（選填；只能進一步縮減權限）。
- 智慧代理允許清單：`agents.list[].tools.elevated.allowFrom`（選填；若設定，傳送者必須 **同時** 符合全域與智慧代理的允許清單）。
- Discord 備援：若省略 `tools.elevated.allowFrom.discord`，則會使用 `channels.discord.dm.allowFrom` 清單作為備援。設定 `tools.elevated.allowFrom.discord`（即使是 `[]`）可覆寫此行為。智慧代理允許清單 **不使用** 備援機制。
- 所有檢查點都必須通過；否則高階模式會被視為不可用。

## 日誌紀錄 + 狀態

- 高階 exec 呼叫會以 info 層級紀錄於日誌中。
- 工作階段狀態會包含高階模式（例如 `elevated=ask`, `elevated=full`）。
