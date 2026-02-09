---
summary: "WhatsApp 群組訊息處理的行為與設定（mentionPatterns 於各個介面共用）"
read_when:
  - 變更群組訊息規則或提及方式時
title: "群組訊息"
---

# 群組訊息（WhatsApp web 頻道）

目標：讓 Clawd 待在 WhatsApp 群組中，只有在被點名時才喚醒，並且將該對話執行緒與個人私訊工作階段分開。

注意：`agents.list[].groupChat.mentionPatterns` 現在也已被 Telegram / Discord / Slack / iMessage 使用；本文檔專注於 WhatsApp 專屬行為。對於多代理程式的設定，請為每個代理程式設定 `agents.list[].groupChat.mentionPatterns`（或使用 `messages.groupChat.mentionPatterns` 作為全域後備）。 9. 對於多代理設定，請為每個代理設定 `agents.list[].groupChat.mentionPatterns`（或使用 `messages.groupChat.mentionPatterns` 作為全域備援）。

## 已實作項目（2025-12-03）

- 10. 啟用模式：`mention`（預設）或 `always`。 11. `mention` 需要被點名（真實 WhatsApp 的 @ 提及，透過 `mentionedJids`、正規表示式模式，或在文字中任意位置出現機器人的 E.164）。 12. `always` 會在每則訊息時喚醒代理，但只有在能提供有意義的價值時才應回覆；否則會回傳靜默權杖 `NO_REPLY`。 13. 預設值可在設定檔中（`channels.whatsapp.groups`）設定，並可透過 `/activation` 針對每個群組覆寫。 14. 設定 `channels.whatsapp.groups` 時，它同時也作為群組 allowlist（包含 `"*"` 以允許全部）。
- 群組政策：`channels.whatsapp.groupPolicy` 控制是否接受群組訊息（`open|disabled|allowlist`）。`allowlist` 會使用 `channels.whatsapp.groupAllowFrom`（後備：明確的 `channels.whatsapp.allowFrom`）。預設為 `allowlist`（在加入寄件者之前一律封鎖）。 15. `allowlist` 使用 `channels.whatsapp.groupAllowFrom`（備援：明確的 `channels.whatsapp.allowFrom`）。 16. 預設為 `allowlist`（在你新增寄件者之前都會被封鎖）。
- 每群組工作階段：工作階段金鑰格式如 `agent:<agentId>:whatsapp:group:<jid>`，因此像 `/verbose on` 或 `/think high`（以單獨訊息送出）的指令僅限於該群組範圍；個人私訊狀態不受影響。群組執行緒會略過心跳訊息。 17. 群組執行緒會略過心跳。
- 情境注入：**僅限待處理**的群組訊息（預設 50 則），且 _未_ 觸發執行的訊息，會在 `[Chat messages since your last reply - for context]` 之下加上前置內容，而觸發的那一行則置於 `[Current message - respond to this]` 之下。已存在於工作階段中的訊息不會再次注入。 18. 已存在於工作階段中的訊息不會重新注入。
- 寄件者呈現：每一批群組訊息結尾都會附上 `[from: Sender Name (+E164)]`，讓 Pi 知道是誰在發言。
- 19. 短暫/僅檢視一次：在擷取文字/提及之前我們會先解包，因此其中的點名仍會觸發。
- 群組系統提示：在群組工作階段的第一個回合（以及每當 `/activation` 變更模式時），我們會在系統提示中注入一段簡短說明，例如 `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`。若無法取得中繼資料，仍會告知代理程式這是一個群組聊天。

## 設定範例（WhatsApp）

在 `~/.openclaw/openclaw.json` 中加入一個 `groupChat` 區塊，讓顯示名稱點名在 WhatsApp 將文字內容中的視覺 `@` 移除時仍能運作：

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

注意事項：

- 20. 正規表示式不分大小寫；涵蓋顯示名稱的點名（如 `@openclaw`）以及原始號碼（可有或沒有 `+`/空白）。
- 當使用者點擊聯絡人時，WhatsApp 仍會透過 `mentionedJids` 傳送標準提及，因此數字後備很少需要，但作為安全網仍然相當實用。

### 啟用指令（僅限擁有者）

使用群組聊天指令：

- `/activation mention`
- `/activation always`

只有擁有者號碼（來自 `channels.whatsapp.allowFrom`，若未設定則為機器人自身的 E.164）可以變更此設定。請在群組中以單獨訊息送出 `/status`，以查看目前的啟用模式。 21. 在群組中以獨立訊息傳送 `/status` 以查看目前的啟用模式。

## 使用方式

1. 將你的 WhatsApp 帳號（執行 OpenClaw 的那個）加入群組。
2. 22. 說 `@openclaw …`（或包含該號碼）。 說 `@openclaw …`（或包含該號碼）。除非你設定 `groupPolicy: "open"`，否則只有在允許清單中的寄件者才能觸發。
3. 代理程式提示會包含最近的群組情境，以及結尾的 `[from: …]` 標記，以便回應正確的對象。
4. 23. 工作階段層級指令（`/verbose on`、`/think high`、`/new` 或 `/reset`、`/compact`）僅適用於該群組的工作階段；請以獨立訊息傳送，才能被註冊。 24. 你的個人 DM 工作階段仍然是獨立的。

## 測試 / 驗證

- 手動冒煙測試：
  - 在群組中送出一個 `@openclaw` 點名，並確認回覆中有引用寄件者名稱。
  - 25. 再送出第二次點名，並確認歷史區塊已被包含，然後在下一回合被清除。
- 檢查 Gateway 閘道器 記錄（以 `--verbose` 執行），查看顯示 `from: <groupJid>` 與 `[from: …]` 後綴的 `inbound web message` 項目。

## 已知注意事項

- 為避免造成大量廣播，群組刻意略過心跳訊息。
- 回音抑制使用合併後的批次字串；若你在未提及的情況下送出完全相同的文字兩次，只有第一次會得到回應。
- 工作階段儲存項目會以 `agent:<agentId>:whatsapp:group:<jid>` 的形式出現在工作階段儲存區中（預設為 `~/.openclaw/agents/<agentId>/sessions/sessions.json`）；若缺少項目，僅表示該群組尚未觸發任何執行。
- 群組中的輸入中指示器遵循 `agents.defaults.typingMode`（預設：未被提及時為 `message`）。
