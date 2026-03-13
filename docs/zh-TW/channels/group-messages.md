---
summary: >-
  Behavior and config for WhatsApp group message handling (mentionPatterns are
  shared across surfaces)
read_when:
  - Changing group message rules or mentions
title: Group Messages
---

# 群組訊息 (WhatsApp 網頁通道)

目標：讓 Clawd 坐在 WhatsApp 群組中，只有在被提及時才會醒來，並將該線程與個人 DM 會話分開。

注意：`agents.list[].groupChat.mentionPatterns` 現在也被 Telegram/Discord/Slack/iMessage 使用；本文件專注於 WhatsApp 特定的行為。對於多代理設置，請為每個代理設置 `agents.list[].groupChat.mentionPatterns`（或使用 `messages.groupChat.mentionPatterns` 作為全域備用）。

## 已實作內容 (2025-12-03)

- 啟用模式：`mention`（預設）或 `always`。`mention` 需要一個 ping（透過 `mentionedJids` 的真實 WhatsApp @-提及、正則表達式模式或機器人的 E.164 在文本中的任何位置）。`always` 在每條消息上喚醒代理，但應該僅在能夠提供有意義的價值時回覆；否則，它會返回靜默 token `NO_REPLY`。預設值可以在設定中設置 (`channels.whatsapp.groups`)，並可通過 `/activation` 在每個群組中覆蓋。當 `channels.whatsapp.groups` 被設置時，它也充當群組允許清單（包括 `"*"` 以允許所有）。
- 群組政策：`channels.whatsapp.groupPolicy` 控制是否接受群組消息 (`open|disabled|allowlist`). `allowlist` 使用 `channels.whatsapp.groupAllowFrom`（後備：明確的 `channels.whatsapp.allowFrom`）。預設為 `allowlist`（在您添加發送者之前被阻止）。
- 每群組會話：會話金鑰看起來像 `agent:<agentId>:whatsapp:group:<jid>`，因此像 `/verbose on` 或 `/think high`（作為獨立消息發送）的命令範圍限於該群組；個人 DM 狀態不受影響。群組線程的心跳會被跳過。
- 上下文注入：**僅待處理**的群組消息（預設 50）未觸發執行的消息會在 `[Chat messages since your last reply - for context]` 下加上前綴，觸發行則在 `[Current message - respond to this]` 下。已在會話中的消息不會重新注入。
- 發送者顯示：每個群組批次現在以 `[from: Sender Name (+E164)]` 結尾，以便 Pi 知道誰在發言。
- 瞬時/一次性查看：我們在提取文本/提及之前會解包這些，因此其中的 ping 仍然會觸發。
- 群組系統提示：在群組會話的第一輪（以及每當 `/activation` 更改模式時），我們會在系統提示中注入一段簡短的說明，例如 `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`。如果元數據不可用，我們仍然告訴代理這是一個群組聊天。

## Config example (WhatsApp)

將 `groupChat` 區塊新增至 `~/.openclaw/openclaw.json`，以便在 WhatsApp 刪除文字主體中的視覺 `@` 時，顯示名稱的標記仍然有效：

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

[[BLOCK_1]]

- 正則表達式不區分大小寫；它們涵蓋了顯示名稱的 ping，如 `@openclaw`，以及帶有或不帶有 `+`/空格的原始號碼。
- 當有人點擊聯絡人時，WhatsApp 仍然通過 `mentionedJids` 發送標準提及，因此號碼回退很少需要，但仍然是一個有用的安全網。

### 啟用指令（僅限擁有者）

使用群組聊天指令：

- `/activation mention`
- `/activation always`

只有擁有者號碼（來自 `channels.whatsapp.allowFrom`，或在未設置時為機器人的 E.164）可以更改此設定。請將 `/status` 作為獨立訊息發送到群組中，以查看當前的啟用模式。

## 如何使用

1. 將你的 WhatsApp 帳號（執行 OpenClaw 的那個）加入群組。
2. 說 `@openclaw …`（或包含該號碼）。只有白名單中的發送者可以觸發它，除非你設置 `groupPolicy: "open"`。
3. 代理提示將包含最近的群組上下文以及結尾的 `[from: …]` 標記，以便能夠正確地稱呼對的人。
4. 會話級指令 (`/verbose on`、`/think high`、`/new` 或 `/reset`、`/compact`) 僅適用於該群組的會話；請將它們作為獨立消息發送，以便註冊。你的個人 DM 會話保持獨立。

## 測試 / 驗證

- 手動測試：
  - 在群組中發送一個 `@openclaw` ping，並確認有回覆提到發送者的名稱。
  - 發送第二個 ping，並驗證歷史區塊已包含然後在下一輪被清除。
- 檢查網關日誌（使用 `--verbose` 執行）以查看 `inbound web message` 條目顯示 `from: <groupJid>` 和 `[from: …]` 後綴。

## 已知考量事項

- 心跳訊號在群組中會故意被跳過，以避免噪音廣播。
- 回音抑制使用合併的批次字串；如果你發送相同的文字兩次且沒有提及，只有第一次會收到回應。
- 會話儲存中的條目將顯示為 `agent:<agentId>:whatsapp:group:<jid>` 在會話儲存中 (`~/.openclaw/agents/<agentId>/sessions/sessions.json` 預設)；缺少的條目僅表示該群組尚未觸發執行。
- 群組中的輸入指示器遵循 `agents.defaults.typingMode` (預設: `message` 當未被提及時)。
