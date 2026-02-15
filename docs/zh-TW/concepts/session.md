---
summary: "聊天工作階段的管理規則、金鑰和持久性"
read_when:
  - 修改工作階段處理或儲存
title: "工作階段管理"
---

# 工作階段管理

OpenClaw 將**每個智慧代理的一個直接聊天工作階段**視為主要工作階段。直接聊天會歸結為 `agent:<agentId>:<mainKey>` (預設為 `main`)，而群組/頻道聊天則有其自己的金鑰。`session.mainKey` 會被遵守。

使用 `session.dmScope` 來控制**私訊**如何分組：

- `main` (預設)：所有私訊共享主要工作階段以保持連續性。
- `per-peer`：按跨頻道的寄件者 ID 隔離。
- `per-channel-peer`：按頻道 + 寄件者隔離 (建議用於多使用者收件匣)。
- `per-account-channel-peer`：按帳戶 + 頻道 + 寄件者隔離 (建議用於多帳戶收件匣)。
使用 `session.identityLinks` 將供應商前綴的對等 ID 對應到規範身分，以便同一個人在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 時跨頻道共享私訊工作階段。

## 安全私訊模式 (建議用於多使用者設定)

> **安全警告：** 如果您的智慧代理可以從**多個人**接收私訊，您應強烈考慮啟用安全私訊模式。否則，所有使用者都會共享相同的對話上下文，這可能會在使用者之間洩露私人資訊。

**預設設定的問題範例：**

- Alice (`<SENDER_A>`) 就私人話題 (例如，醫療預約) 向您的智慧代理發送訊息
- Bob (`<SENDER_B>`) 向您的智慧代理發送訊息詢問「我們在聊什麼？」
- 因為兩個私訊共享同一個工作階段，模型可能會使用 Alice 先前的上下文來回答 Bob。

**解決方案：** 將 `dmScope` 設定為每個使用者隔離工作階段：

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // 安全私訊模式：按頻道 + 寄件者隔離私訊上下文。
    dmScope: "per-channel-peer",
  },
}
```

**何時啟用此功能：**

- 您有多個寄件者的配對批准
- 您使用包含多個條目的私訊允許清單
- 您將 `dmPolicy: "open"` 設定為「開放」
- 多個電話號碼或帳戶可以向您的智慧代理發送訊息

注意事項：

- 預設為 `dmScope: "main"` 以保持連續性 (所有私訊共享主要工作階段)。這對於單使用者設定是沒有問題的。
- 對於同一頻道上的多帳戶收件匣，請優先選擇 `per-account-channel-peer`。
- 如果同一個人透過多個頻道聯絡您，請使用 `session.identityLinks` 將他們的私訊工作階段合併為一個規範身分。
- 您可以使用 `openclaw security audit` 來驗證您的私訊設定 (請參閱 [security](/cli/security))。

## Gateway 是真實來源

所有工作階段狀態都**由 Gateway 擁有** (即「主」OpenClaw)。UI 客戶端 (macOS 應用程式、WebChat 等) 必須向 Gateway 查詢工作階段列表和權杖計數，而不是讀取本地檔案。

- 在**遠端模式**下，您關心的工作階段儲存位於遠端 Gateway 主機上，而不是您的 Mac 上。
- UI 中顯示的權杖計數來自 Gateway 的儲存欄位 (`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`)。客戶端不會解析 JSONL 轉錄來「修正」總數。

## 狀態儲存位置

- 在 **Gateway 主機**上：
  - 儲存檔案：`~/.openclaw/agents/<agentId>/sessions/sessions.json` (每個智慧代理)。
- 轉錄：`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (Telegram 主題工作階段使用 `.../<SessionId>-topic-<threadId>.jsonl`)。
- 儲存是一個映射 `sessionKey -> { sessionId, updatedAt, ... }`。刪除條目是安全的；它們會按需重新建立。
- 群組條目可能包含 `displayName`、`channel`、`subject`、`room` 和 `space`，以在 UI 中標記工作階段。
- 工作階段條目包含 `origin` 元資料 (標籤 + 路由提示)，以便 UI 可以解釋工作階段的來源。
- OpenClaw **不**讀取舊版 Pi/Tau 工作階段資料夾。

## 工作階段修剪

OpenClaw 預設會在 LLM 呼叫之前，從記憶體上下文修剪**舊的工具結果**。
這**不會**重寫 JSONL 歷史紀錄。請參閱 [/concepts/session-pruning](/concepts/session-pruning)。

## 預壓縮記憶體刷新

當工作階段接近自動壓縮時，OpenClaw 可以執行**無聲記憶體刷新**
提醒模型將持久筆記寫入磁碟。這僅在工作區可寫入時執行。請參閱 [Memory](/concepts/memory) 和
[Compaction](/concepts/compaction)。

## 映射傳輸協定 → 工作階段金鑰

- 直接聊天遵循 `session.dmScope` (預設為 `main`)。
  - `main`：`agent:<agentId>:<mainKey>` (跨裝置/頻道的連續性)。
    - 多個電話號碼和頻道可以映射到同一個智慧代理主金鑰；它們作為一個對話的傳輸。
  - `per-peer`：`agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`：`agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`：`agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (`accountId` 預設為 `default`)。
  - 如果 `session.identityLinks` 匹配供應商前綴的對等 ID (例如 `telegram:123`)，則規範金鑰會替換 `<peerId>`，以便同一個人在跨頻道共享工作階段。
- 群組聊天隔離狀態：`agent:<agentId>:<channel>:group:<id>` (聊天室/頻道使用 `agent:<agentId>:<channel>:channel:<id>`)。
  - Telegram 論壇主題會在群組 ID 後附加 `:topic:<threadId>` 以進行隔離。
  - 為了遷移，仍然識別舊版 `group:<id>` 金鑰。
- 入站上下文可能仍使用 `group:<id>`；頻道是從 `Provider` 推斷出來的，並正規化為規範的 `agent:<agentId>:<channel>:group:<id>` 形式。
- 其他來源：
  - 排程工作：`cron:<job.id>`
  - Webhook：`hook:<uuid>` (除非由 webhook 明確設定)
  - 節點執行：`node-<nodeId>`

## 生命週期

- 重設政策：工作階段會被重複使用直到過期，並且在下一個入站訊息時評估過期。
- 每日重設：預設為 **Gateway 主機上的當地時間上午 4:00**。一旦工作階段的上次更新早於最近的每日重設時間，該工作階段就會過時。
- 閒置重設 (可選)：`idleMinutes` 會增加一個滑動閒置窗口。當每日和閒置重設都配置時，**任何一個先過期**都會強制建立一個新工作階段。
- 舊版僅閒置：如果您設定 `session.idleMinutes` 而沒有任何 `session.reset`/`resetByType` 設定，OpenClaw 將保持在僅閒置模式以實現向後相容性。
- 每個類型覆寫 (可選)：`resetByType` 讓您可以覆寫 `direct`、`group` 和 `thread` 工作階段的政策 (thread = Slack/Discord 討論串、Telegram 主題、由連接器提供的 Matrix 討論串)。
- 每個頻道覆寫 (可選)：`resetByChannel` 覆寫頻道的重設政策 (適用於該頻道的_所有_工作階段類型，並優先於 `reset`/`resetByType`)。
- 重設觸發器：精確的 `/new` 或 `/reset` (以及 `resetTriggers` 中的任何額外內容) 會啟動一個全新的工作階段 ID，並將訊息的其餘部分傳遞過去。`/new <model>` 接受模型別名、`provider/model` 或供應商名稱 (模糊匹配) 來設定新工作階段模型。如果單獨發送 `/new` 或 `/reset`，OpenClaw 會執行一個簡短的「問候」轉發以確認重設。
- 手動重設：從儲存中刪除特定金鑰或刪除 JSONL 轉錄；下一個訊息會重新建立它們。
- 隔離的排程工作始終為每次執行建立一個新的 `sessionId` (沒有閒置重用)。

## 發送政策 (可選的重新命名範例)

阻止特定工作階段類型的傳遞，而無需列出單個 ID。

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

執行時覆寫 (僅限所有者)：

- `/send on` → 允許此工作階段
- `/send off` → 拒絕此工作階段
- `/send inherit` → 清除覆寫並使用設定規則
將這些作為獨立訊息發送，以便它們註冊。

## 設定 (可選的重新命名範例)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // 保持群組金鑰分離
    dmScope: "main", // 私訊連續性 (對於共享收件匣設定為 per-channel-peer/per-account-channel-peer)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // 預設：模式=每日，atHour=4 (Gateway 主機當地時間)。
      // 如果您也設定了 idleMinutes，則先過期的優先。
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## 檢查

- `openclaw status` — 顯示儲存路徑和最近的工作階段。
- `openclaw sessions --json` — 轉儲每個條目 (使用 `--active <minutes>` 篩選)。
- `openclaw gateway call sessions.list --params '{}'` — 從正在執行的 Gateway 擷取工作階段 (使用 `--url`/`--token` 進行遠端 Gateway 存取)。
- 在聊天中發送獨立訊息 `/status` 以查看智慧代理是否可達、使用了多少工作階段上下文、當前的思考/詳細切換，以及您的 WhatsApp 網頁憑證上次重新整理的時間 (有助於發現重新連結需求)。
- 發送 `/context list` 或 `/context detail` 以查看系統提示和注入的工作區檔案中包含的內容 (以及最大的上下文貢獻者)。
- 發送獨立訊息 `/stop` 以中止當前執行、清除該工作階段的排隊後續操作，並停止從中衍生出的任何子智慧代理執行 (回覆包含已停止的計數)。
- 發送獨立訊息 `/compact` (可選說明) 以總結舊的上下文並釋放窗口空間。請參閱 [/concepts/compaction](/concepts/compaction)。
- JSONL 轉錄可以直接打開以查看完整的轉發。

## 提示

- 保持主金鑰專用於 1:1 流量；讓群組保留自己的金鑰。
- 自動化清理時，刪除單個金鑰而不是整個儲存，以保留其他位置的上下文。

## 工作階段來源元資料

每個工作階段條目都記錄了其來源 (盡力而為) 在 `origin` 中：

- `label`：人類可讀的標籤 (從對話標籤 + 群組主題/頻道解析)
- `provider`：正規化的頻道 ID (包括擴充功能)
- `from`/`to`：來自入站封包的原始路由 ID
- `accountId`：供應商帳戶 ID (多帳戶時)
- `threadId`：當頻道支援時的討論串/主題 ID
`origin` 欄位會填充用於直接訊息、頻道和群組。如果連接器僅更新傳遞路由 (例如，為了保持私訊主要工作階段新鮮)，它仍應提供入站上下文，以便工作階段保留其解釋器元資料。擴充功能可以透過在入站上下文中發送 `ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace` 和 `SenderName`，並呼叫 `recordSessionMetaFromInbound` (或將相同的上下文傳遞給 `updateLastRoute`) 來實現此目的。
