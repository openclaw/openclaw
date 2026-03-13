---
summary: Elevated exec mode and /elevated directives
read_when:
  - "Adjusting elevated mode defaults, allowlists, or slash command behavior"
title: Elevated Mode
---

# 提升模式 (/elevated 指令)

## 功能說明

- `/elevated on` 在閘道主機上執行並保留執行批准（與 `/elevated ask` 相同）。
- `/elevated full` 在閘道主機上執行，且自動批准執行（跳過執行批准）。
- `/elevated ask` 在閘道主機上執行但保留執行批准（與 `/elevated on` 相同）。
- `on`/`ask` 不會強制 `exec.security=full`；已設定的安全/詢問政策仍然適用。
- 僅在代理為 **沙盒環境** 時改變行為（否則執行已在主機上執行）。
- 指令形式：`/elevated on|off|ask|full`、`/elev on|off|ask|full`。
- 僅接受 `on|off|ask|full`；其他任何指令會回傳提示且不改變狀態。

## 控制範圍（及不控制的部分）

- **可用性門檻**：`tools.elevated` 是全域基準。`agents.list[].tools.elevated` 可進一步限制每個代理的提升權限（兩者皆須允許）。
- **每次會話狀態**：`/elevated on|off|ask|full` 設定當前會話金鑰的提升等級。
- **內嵌指令**：訊息內的 `/elevated on|ask|full` 僅適用於該訊息。
- **群組**：在群組聊天中，只有當代理被提及時才會執行提升指令。繞過提及要求的純指令訊息視為已提及。
- **主機執行**：提升模式強制 `exec` 在閘道主機上執行；`full` 也會設定 `security=full`。
- **批准**：`full` 跳過執行批准；`on`/`ask` 在允許清單/詢問規則要求時仍會遵守批准。
- **非沙盒代理**：位置設定無效；僅影響門檻、日誌與狀態。
- **工具政策仍適用**：若 `exec` 被工具政策拒絕，則無法使用提升模式。
- **與 `/exec` 分開**：`/exec` 調整授權發送者的每次會話預設，且不需提升權限。

## 解決順序

1. 訊息中的內嵌指令（僅適用於該訊息）。
2. 會話覆寫（由純指令訊息設定）。
3. 全域預設（設定檔中的 `agents.defaults.elevatedDefault`）。

## 設定會話預設

- 傳送僅包含指令的訊息（允許空白字元），例如 `/elevated full`。
- 會收到確認回覆（`Elevated mode set to full...` / `Elevated mode disabled.`）。
- 若提升存取被禁用或發送者不在核准清單中，指令會回覆可操作的錯誤，且不改變會話狀態。
- 傳送 `/elevated`（或 `/elevated:`）且不帶參數，可查看當前提升等級。

## 可用性與核准清單

- 功能門檻：`tools.elevated.enabled`（即使程式碼支援，預設可透過設定關閉）。
- 發送者核准清單：`tools.elevated.allowFrom`，包含每個提供者的核准清單（例如 `discord`、`whatsapp`）。
- 無前綴的核准清單條目僅匹配發送者範圍的身份值（`SenderId`、`SenderE164`、`From`）；收件者路由欄位從不用於提升授權。
- 可變發送者元資料需明確前綴：
  - `name:<value>` 匹配 `SenderName`
  - `username:<value>` 匹配 `SenderUsername`
  - `tag:<value>` 匹配 `SenderTag`
  - `id:<value>`、`from:<value>`、`e164:<value>` 可用於明確身份目標設定
- 每代理門檻：`agents.list[].tools.elevated.enabled`（可選；只能進一步限制）。
- 每代理核准清單：`agents.list[].tools.elevated.allowFrom`（可選；設定時，發送者必須同時符合全域與每代理核准清單）。
- Discord 備援：若省略 `tools.elevated.allowFrom.discord`，則使用 `channels.discord.allowFrom` 清單作為備援（舊版為 `channels.discord.dm.allowFrom`）。可設定 `tools.elevated.allowFrom.discord`（甚至 `[]`）來覆寫。每代理核准清單不使用備援。
- 所有門檻必須通過，否則提升模式視為不可用。

## 日誌與狀態

- 提升執行呼叫會以 info 級別記錄日誌。
- 會話狀態包含提升模式（例如 `elevated=ask`、`elevated=full`）。
