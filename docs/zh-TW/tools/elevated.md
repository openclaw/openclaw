---
summary: "提升的 exec 模式與 /elevated 指令"
read_when:
  - 調整提升模式的預設值、允許清單，或斜線指令行為時
title: "提升模式"
x-i18n:
  source_path: tools/elevated.md
  source_hash: 83767a0160930402
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:35Z
---

# 提升模式（/elevated 指令）

## 功能說明

- `/elevated on` 在 Gateway 閘道器主機上執行，並保留 exec 核准（與 `/elevated ask` 相同）。
- `/elevated full` 在 Gateway 閘道器主機上執行 **且** 自動核准 exec（略過 exec 核准）。
- `/elevated ask` 在 Gateway 閘道器主機上執行，但保留 exec 核准（與 `/elevated on` 相同）。
- `on`/`ask` **不會** 強制 `exec.security=full`；已設定的安全性／詢問政策仍然適用。
- 僅在代理程式為 **sandboxed** 時才會改變行為（否則 exec 已在主機上執行）。
- 指令形式：`/elevated on|off|ask|full`、`/elev on|off|ask|full`。
- 僅接受 `on|off|ask|full`；任何其他內容都會回傳提示且不會改變狀態。

## 控制範圍（以及不包含的部分）

- **可用性閘門**：`tools.elevated` 是全域基準。`agents.list[].tools.elevated` 可進一步限制每個代理程式的提升權限（兩者都必須允許）。
- **每個工作階段狀態**：`/elevated on|off|ask|full` 會為目前的工作階段金鑰設定提升層級。
- **行內指令**：訊息內的 `/elevated on|ask|full` 僅套用於該則訊息。
- **群組**：在群組聊天中，只有在提及代理程式時才會採用提升指令。可略過提及需求的純指令訊息會被視為已提及。
- **主機執行**：提升會將 `exec` 強制到 Gateway 閘道器主機；`full` 也會設定 `security=full`。
- **核准**：`full` 會略過 exec 核准；`on`/`ask` 在允許清單／詢問規則要求時會遵循核准。
- **未沙箱化的代理程式**：對位置而言為 no-op；僅影響閘門、記錄與狀態。
- **工具政策仍然適用**：若 `exec` 被工具政策拒絕，則無法使用提升模式。
- **與 `/exec` 分離**：`/exec` 會為已授權的寄件者調整每個工作階段的預設值，且不需要提升模式。

## 解析順序

1. 訊息上的行內指令（僅套用於該則訊息）。
2. 工作階段覆寫（透過傳送僅包含指令的訊息設定）。
3. 全域預設（設定中的 `agents.defaults.elevatedDefault`）。

## 設定工作階段預設值

- 傳送一則 **僅** 包含指令的訊息（允許空白），例如 `/elevated full`。
- 會傳送確認回覆（`Elevated mode set to full...`／`Elevated mode disabled.`）。
- 若提升存取已停用或寄件者不在核准的允許清單中，指令會回覆可採取行動的錯誤，且不會改變工作階段狀態。
- 傳送 `/elevated`（或 `/elevated:`）且不帶參數，可查看目前的提升層級。

## 可用性＋允許清單

- 功能閘門：`tools.elevated.enabled`（即使程式碼支援，預設也可透過設定關閉）。
- 寄件者允許清單：`tools.elevated.allowFrom`，並提供各提供者的允許清單（例如 `discord`、`whatsapp`）。
- 每個代理程式的閘門：`agents.list[].tools.elevated.enabled`（選用；只能進一步限制）。
- 每個代理程式的允許清單：`agents.list[].tools.elevated.allowFrom`（選用；設定後，寄件者必須同時符合 **全域＋每個代理程式** 的允許清單）。
- Discord 後備：若省略 `tools.elevated.allowFrom.discord`，會使用 `channels.discord.dm.allowFrom` 清單作為後備。設定 `tools.elevated.allowFrom.discord`（即使是 `[]`）即可覆寫。每個代理程式的允許清單 **不會** 使用後備。
- 必須通過所有閘門；否則提升模式會被視為不可用。

## 記錄＋狀態

- 提升的 exec 呼叫會以 info 等級記錄。
- 工作階段狀態包含提升模式（例如 `elevated=ask`、`elevated=full`）。
