---
summary: "WhatsApp 群組訊息處理的行為與設定 (mentionPatterns 在所有介面上共用)"
read_when:
  - 變更群組訊息規則或提及設定
title: "群組訊息"
---

# 群組訊息 (WhatsApp 網路頻道)

目標：讓 Clawd 待在 WhatsApp 群組中，只在被提及時才喚醒，並將該執行緒與個人私訊工作階段分開。

注意：`agents.list[].groupChat.mentionPatterns` 現在也用於 Telegram/Discord/Slack/iMessage；本文檔重點介紹 WhatsApp 的特定行為。對於多智慧代理設定，請為每個智慧代理設定 `agents.list[].groupChat.mentionPatterns`（或使用 `messages.groupChat.mentionPatterns` 作為全域預設值）。

## 已實施的功能 (2025-12-03)

- 啟動模式：`mention` (預設) 或 `always`。`mention` 需要提及（透過 `mentionedJids` 的實際 WhatsApp @-提及、正規表示式模式，或訊息中任意位置的機器人 E.164 號碼）。`always` 會在每則訊息時喚醒智慧代理，但它只應在能增加有意義的價值時才回覆；否則它會回傳靜默的權杖 `NO_REPLY`。預設值可以在設定中設定 (`channels.whatsapp.groups`)，並透過 `/activation` 為每個群組覆寫。當設定 `channels.whatsapp.groups` 時，它也作為群組允許清單（包含 `"*"` 允許所有）。
- 群組政策：`channels.whatsapp.groupPolicy` 控制是否接受群組訊息 (`open|disabled|allowlist`)。`allowlist` 使用 `channels.whatsapp.groupAllowFrom` (預設：明確的 `channels.whatsapp.allowFrom`)。預設值為 `allowlist` (在您新增寄件者之前會被封鎖)。
- 每群組工作階段：工作階段鍵名看起來像 `agent:<agentId>:whatsapp:group:<jid>`，因此諸如 `/verbose on` 或 `/think high` (作為獨立訊息傳送) 等命令僅限於該群組；個人私訊狀態不受影響。群組執行緒會跳過心跳。
- 情境注入：**僅限擱置中**的群組訊息 (預設 50 則)，若_未_觸發執行，則會在 `[自上次回覆以來的聊天訊息 - 供參考]` 下加上前綴，觸發行則在 `[當前訊息 - 回覆此訊息]` 下。已在工作階段中的訊息不會重新注入。
- 寄件者顯示：每個群組批次現在都會以 `[from: 寄件者姓名 (+E164)]` 結尾，以便 Pi 知道是誰在說話。
- 閱後即焚/一次性檢視：我們會在提取文字/提及之前解開這些訊息，因此其中的提及仍然會觸發。
- 群組系統提示：在群組工作階段的第一個回合（以及每當 `/activation` 變更模式時），我們會在系統提示中注入一段簡短的說明，例如 `您正在 WhatsApp 群組 "<主題>" 中回覆。群組成員：Alice (+44...)、Bob (+43...)、... 啟動：僅觸發 ... 請回覆訊息內容中指定的寄件者。` 如果中繼資料不可用，我們仍然會告知智慧代理這是一個群組聊天。

## 設定範例 (WhatsApp)

將 `groupChat` 區塊新增至 `~/.openclaw/openclaw.json`，以便即使 WhatsApp 從文字主體中移除視覺上的 ` @`，顯示名稱提及也能運作：

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

注意事項：

- 正規表示式不區分大小寫；它們涵蓋了像 ` @openclaw` 這樣的顯示名稱提及，以及帶有或不帶 `+`/空格的原始號碼。
- 當有人點擊聯絡人時，WhatsApp 仍然會透過 `mentionedJids` 傳送規範的提及，因此號碼預設很少需要，但它是一個有用的安全網。

### 啟動命令 (僅限擁有者)

使用群組聊天命令：

- `/activation mention`
- `/activation always`

只有擁有者號碼 (來自 `channels.whatsapp.allowFrom`，或在未設定時為機器人自己的 E.164) 才能更改此設定。在群組中以獨立訊息傳送 `/status` 以查看目前的啟動模式。

## 如何使用

1. 將您的 WhatsApp 帳戶 (執行 OpenClaw 的帳戶) 加入群組。
2. 說 ` @openclaw …` (或包含號碼)。除非您設定 `groupPolicy: "open"`，否則只有允許清單中的寄件者才能觸發它。
3. 智慧代理提示將包含最近的群組情境以及尾隨的 `[from: …]` 標記，以便它可以回覆正確的人。
4. 工作階段層級指令 (`/verbose on`、`/think high`、`/new` 或 `/reset`、`/compact`) 僅適用於該群組的工作階段；將它們作為獨立訊息傳送，以便它們註冊。您的個人私訊工作階段保持獨立。

## 測試 / 驗證

- 手動煙霧測試：
  - 在群組中傳送 ` @openclaw` 提及並確認回覆提及寄件者姓名。
  - 傳送第二次提及並驗證歷史區塊已包含，然後在下一個回合清除。
- 檢查 Gateway 記錄檔 (使用 `--verbose` 執行) 以查看顯示 `from: <groupJid>` 和 `[from: …]` 後綴的 `inbound web message` 條目。

## 已知考量

- 群組會刻意跳過心跳，以避免產生吵雜的廣播。
- 回音抑制使用組合批次字串；如果您在沒有提及的情況下傳送兩次相同的文字，則只有第一次會收到回應。
- 工作階段儲存區條目將以 `agent:<agentId>:whatsapp:group:<jid>` 形式出現在工作階段儲存區中 (預設為 `~/.openclaw/agents/<agentId>/sessions/sessions.json`)；缺少條目僅表示該群組尚未觸發執行。
- 群組中的打字指示器遵循 `agents.defaults.typingMode` (預設：未提及時為 `message`)。
