---
summary: "提升的執行模式與 /elevated 指令"
read_when:
  - 調整提升模式的預設值、允許清單或斜線指令行為
title: "提升模式"
---

# 提升模式 (/elevated 指令)

## 功能

- `/elevated on` 會在 Gateway 主機上執行並保留執行核准（與 `/elevated ask` 相同）。
- `/elevated full` 會在 Gateway 主機上執行**並**自動核准執行（跳過執行核准）。
- `/elevated ask` 會在 Gateway 主機上執行但保留執行核准（與 `/elevated on` 相同）。
- `on`/`ask` **不會**強制 `exec.security=full`；仍適用已設定的安全/詢問政策。
- 僅在智慧代理為**沙箱隔離**時才改變行為（否則執行已在主機上執行）。
- 指令形式：`/elevated on|off|ask|full`、`/elev on|off|ask|full`。
- 僅接受 `on|off|ask|full`；任何其他輸入將回傳提示且不改變狀態。

## 控制範圍（與不控制的範圍）

- **可用性閘門**：`tools.elevated` 是全域基準。`agents.list[].tools.elevated` 可以進一步限制每個智慧代理的提升權限（兩者都必須允許）。
- **每個工作階段的狀態**：`/elevated on|off|ask|full` 設定目前工作階段金鑰的提升權限等級。
- **內聯指令**：訊息中的 `/elevated on|ask|full` 僅適用於該訊息。
- **群組**：在群組聊天中，提升指令僅在提及智慧代理時才有效。繞過提及要求的純指令訊息會被視為已被提及。
- **主機執行**：`elevated` 強制 `exec` 在 Gateway 主機上執行；`full` 也會設定 `security=full`。
- **核准**：`full` 跳過執行核准；`on`/`ask` 在允許清單/詢問規則要求時尊重它們。
- **非沙箱隔離智慧代理**：對於位置無操作；僅影響閘門、日誌記錄和狀態。
- **工具政策仍然適用**：如果 `exec` 被工具政策拒絕，則不能使用提升模式。
- **與 `/exec` 分開**：`/exec` 調整授權發送者的每個工作階段預設值，且不需要提升模式。

## 解析順序

1.  訊息中的內聯指令（僅適用於該訊息）。
2.  工作階段覆寫（透過發送純指令訊息設定）。
3.  全域預設值（設定中的 `agents.defaults.elevatedDefault`）。

## 設定工作階段預設值

- 發送**僅包含**指令的訊息（允許空格），例如 `/elevated full`。
- 發送確認回覆（`提升模式設定為 full...` / `提升模式已停用。`）。
- 如果已停用提升存取或發送者不在核准的允許清單中，指令會回覆可操作的錯誤且不改變工作階段狀態。
- 發送不帶參數的 `/elevated`（或 `/elevated:`）以查看目前的提升權限等級。

## 可用性 + 允許清單

- 功能閘門：`tools.elevated.enabled`（即使程式碼支援，預設也可以透過設定關閉）。
- 發送者允許清單：`tools.elevated.allowFrom` 帶有每個供應商的允許清單（例如 `discord`、`whatsapp`）。
- 每個智慧代理的閘門：`agents.list[].tools.elevated.enabled`（選填；只能進一步限制）。
- 每個智慧代理的允許清單：`agents.list[].tools.elevated.allowFrom`（選填；設定後，發送者必須符合**全域與每個智慧代理**的允許清單）。
- Discord 備用方案：如果省略 `tools.elevated.allowFrom.discord`，則使用 `channels.discord.dm.allowFrom` 清單作為備用。設定 `tools.elevated.allowFrom.discord`（甚至是 `[]`）以覆寫。每個智慧代理的允許清單**不**使用備用方案。
- 所有閘門都必須通過；否則提升模式將被視為不可用。

## 日誌記錄 + 狀態

- 提升的執行呼叫會以資訊等級記錄。
- 工作階段狀態包括提升模式（例如 `elevated=ask`、`elevated=full`）。
