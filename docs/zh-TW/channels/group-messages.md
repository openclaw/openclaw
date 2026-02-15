---
summary: "WhatsApp 群組訊息處理的行為與設定 (mentionPatterns 在不同介面間共用)"
read_when:
  - 變更群組訊息規則或提及（mentions）時
title: "群組訊息"
---

# 群組訊息 (WhatsApp web 頻道)

目標：讓 Clawd 待在 WhatsApp 群組中，僅在被標記（ping）時喚醒，並將該對話串與個人私訊（DM）工作階段分開。

注意：`agents.list[].groupChat.mentionPatterns` 現在也可用於 Telegram/Discord/Slack/iMessage；本文件專注於 WhatsApp 特有的行為。對於多智慧代理設定，請為每個智慧代理設定 `agents.list[].groupChat.mentionPatterns`（或使用 `messages.groupChat.mentionPatterns` 作為全域後備選項）。

## 已實作功能 (2025-12-03)

- 啟用模式：`mention`（預設）或 `always`。`mention` 需要標記（透過 `mentionedJids` 的真實 WhatsApp @-mentions、正規表示式模式，或文字中任何位置的機器人 E.164 號碼）。`always` 會在每條訊息傳入時喚醒智慧代理，但它應僅在能提供有意義的價值時才回覆；否則它會回傳靜默權杖（token） `NO_REPLY`。預設值可在設定中設定 (`channels.whatsapp.groups`)，並可透過 `/activation` 在每個群組中覆寫。當設定 `channels.whatsapp.groups` 時，它也會作為群組允許清單（加入 `"*"` 以允許所有群組）。
- 群組策略：`channels.whatsapp.groupPolicy` 控制是否接受群組訊息 (`open|disabled|allowlist`)。`allowlist` 使用 `channels.whatsapp.groupAllowFrom`（後備選項：明確的 `channels.whatsapp.allowFrom`）。預設為 `allowlist`（在您新增發送者之前會被阻擋）。
- 獨立群組工作階段：工作階段鍵名（session keys）格式為 `agent:<agentId>:whatsapp:group:<jid>`，因此指令如 `/verbose on` 或 `/think high`（作為獨立訊息發送）的作用範圍僅限於該群組；個人私訊狀態不會受到影響。群組對話串會跳過 Heartbeats。
- 上下文注入：未觸發執行的待處理群組訊息（預設為 50 則）會加上 `[Chat messages since your last reply - for context]` 前綴，而觸發訊息則放在 `[Current message - respond to this]` 之下。已存在於工作階段中的訊息不會重複注入。
- 顯示發送者：現在每個群組批次結尾都會加上 `[from: Sender Name (+E164)]`，讓 Pi 知道是誰在說話。
- 限時訊息/閱後即焚：我們會在提取文字/提及之前先解開這些訊息，因此其中的標記仍會觸發。
- 群組系統提示詞：在群組工作階段的第一輪（以及每當 `/activation` 變更模式時），我們會向系統提示詞中注入一段簡短說明，例如：`You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` 如果無法取得詮釋資料（metadata），我們仍會告知智慧代理這是群組聊天。

## 設定範例 (WhatsApp)

在 `~/.openclaw/openclaw.json` 中新增 `groupChat` 區塊，這樣即使 WhatsApp 在文字內容中移除視覺上的 `@`，顯示名稱的標記仍能運作：

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
          mentionPatterns: [" @?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

備註：

- 正規表示式不區分大小寫；它們涵蓋了像 `@openclaw` 這樣的顯示名稱標記，以及帶有或不帶有 `+`/空格的原始號碼。
- 當有人點擊聯絡人時，WhatsApp 仍會透過 `mentionedJids` 發送標準提及，因此號碼後備選項很少需要，但仍是一個有用的安全防護。

### 啟用指令（僅限擁有者）

使用群組聊天指令：

- `/activation mention`
- `/activation always`

只有擁有者號碼（來自 `channels.whatsapp.allowFrom`，若未設定則為機器人自己的 E.164 號碼）可以變更此項。在群組中發送獨立訊息 `/status` 即可查看目前的啟用模式。

## 如何使用

1. 將您的 WhatsApp 帳號（執行 OpenClaw 的帳號）加入群組。
2. 輸入 `@openclaw …`（或包含號碼）。除非您將 `groupPolicy` 設定為 `"open"`，否則只有在允許清單中的發送者可以觸發它。
3. 智慧代理的提示詞將包含最近的群組上下文，加上結尾的 `[from: …]` 標記，以便它能回覆正確的人。
4. 工作階段層級的指令（`/verbose on`、`/think high`、`/new` 或 `/reset`、`/compact`）僅適用於該群組的工作階段；請將它們作為獨立訊息發送以便記錄。您的個人私訊工作階段保持獨立。

## 測試 / 驗證

- 手動冒煙測試：
  - 在群組中發送 `@openclaw` 標記，並確認回覆中提及了發送者姓名。
  - 發送第二次標記，並驗證歷史區塊已包含在內，然後在下一輪被清除。
- 檢查 Gateway 紀錄（執行時加上 `--verbose`），查看 `inbound web message` 分目，確認顯示 `from: <groupJid>` 以及 `[from: …]` 後綴。

## 已知注意事項

- 群組故意跳過 Heartbeats 以避免干擾廣播。
- 回聲抑制（Echo suppression）使用合併後的批次字串；如果您發送兩次相同文字且未標記，則只有第一則會收到回覆。
- 工作階段儲存分目將以 `agent:<agentId>:whatsapp:group:<jid>` 的形式出現在工作階段儲存中（預設路徑為 `~/.openclaw/agents/<agentId>/sessions/sessions.json`）；遺漏分目僅代表該群組尚未觸發執行。
- 群組中的打字指示器遵循 `agents.defaults.typingMode`（預設：未被提及時為 `message`）。
