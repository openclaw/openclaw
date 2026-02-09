---
summary: "提升的 exec 模式與 /elevated 指令"
read_when:
  - 調整提升模式的預設值、允許清單，或斜線指令行為時
title: "提升模式"
---

# 提升模式（/elevated 指令）

## What it does

- `/elevated on` 在 Gateway 閘道器主機上執行，並保留 exec 核准（與 `/elevated ask` 相同）。
- `/elevated full` 在 Gateway 閘道器主機上執行 **且** 自動核准 exec（略過 exec 核准）。
- `/elevated ask` 在 Gateway 閘道器主機上執行，但保留 exec 核准（與 `/elevated on` 相同）。
- `on`/`ask` **不會** 強制 `exec.security=full`；已設定的安全性／詢問政策仍然適用。
- 僅在代理程式為 **sandboxed** 時才會改變行為（否則 exec 已在主機上執行）。
- 指令形式：`/elevated on|off|ask|full`、`/elev on|off|ask|full`。
- Only `on|off|ask|full` are accepted; anything else returns a hint and does not change state.

## 控制範圍（以及不包含的部分）

- **Availability gates**: `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can further restrict elevated per agent (both must allow).
- **Per-session state**: `/elevated on|off|ask|full` sets the elevated level for the current session key.
- **行內指令**：訊息內的 `/elevated on|ask|full` 僅套用於該則訊息。
- **群組**：在群組聊天中，只有在提及代理程式時才會採用提升指令。可略過提及需求的純指令訊息會被視為已提及。 Command-only messages that bypass mention requirements are treated as mentioned.
- **主機執行**：提升會將 `exec` 強制到 Gateway 閘道器主機；`full` 也會設定 `security=full`。
- **核准**：`full` 會略過 exec 核准；`on`/`ask` 在允許清單／詢問規則要求時會遵循核准。
- **Unsandboxed agents**: no-op for location; only affects gating, logging, and status.
- **工具政策仍然適用**：若 `exec` 被工具政策拒絕，則無法使用提升模式。
- **與 `/exec` 分離**：`/exec` 會為已授權的寄件者調整每個工作階段的預設值，且不需要提升模式。

## Resolution order

1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. 全域預設（設定中的 `agents.defaults.elevatedDefault`）。

## Setting a session default

- 傳送一則 **僅** 包含指令的訊息（允許空白），例如 `/elevated full`。
- 會傳送確認回覆（`Elevated mode set to full...`／`Elevated mode disabled.`）。
- If elevated access is disabled or the sender is not on the approved allowlist, the directive replies with an actionable error and does not change session state.
- 傳送 `/elevated`（或 `/elevated:`）且不帶參數，可查看目前的提升層級。

## 可用性＋允許清單

- 功能閘門：`tools.elevated.enabled`（即使程式碼支援，預設也可透過設定關閉）。
- 寄件者允許清單：`tools.elevated.allowFrom`，並提供各提供者的允許清單（例如 `discord`、`whatsapp`）。
- 每個代理程式的閘門：`agents.list[].tools.elevated.enabled`（選用；只能進一步限制）。
- 每個代理程式的允許清單：`agents.list[].tools.elevated.allowFrom`（選用；設定後，寄件者必須同時符合 **全域＋每個代理程式** 的允許清單）。
- Discord 後備：若省略 `tools.elevated.allowFrom.discord`，會使用 `channels.discord.dm.allowFrom` 清單作為後備。設定 `tools.elevated.allowFrom.discord`（即使是 `[]`）即可覆寫。每個代理程式的允許清單 **不會** 使用後備。 Set `tools.elevated.allowFrom.discord` (even `[]`) to override. Per-agent allowlists do **not** use the fallback.
- 必須通過所有閘門；否則提升模式會被視為不可用。

## 記錄＋狀態

- 提升的 exec 呼叫會以 info 等級記錄。
- 1. 工作階段狀態包含提升模式（例如 `elevated=ask`、`elevated=full`）。
