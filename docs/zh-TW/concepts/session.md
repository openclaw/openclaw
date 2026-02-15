---
summary: "對話的工作階段管理規則、鍵名與持久化"
read_when:
  - 修改工作階段處理或儲存方式時
title: "工作階段管理"
---

# 工作階段管理

OpenClaw 將 **每個智慧代理的一個私訊工作階段** 視為主要工作階段。私訊會合併為 `agent:<agentId>:<mainKey>`（預設為 `main`），而群組/頻道聊天則有各自的鍵名。系統會遵循 `session.mainKey` 設定。

使用 `session.dmScope` 來控制 **私訊** 的群組方式：

- `main`（預設）：所有私訊共享主工作階段以保持連續性。
- `per-peer`：跨頻道根據傳送者 ID 進行隔離。
- `per-channel-peer`：根據頻道 + 傳送者進行隔離（建議用於多使用者收件匣）。
- `per-account-channel-peer`：根據帳號 + 頻道 + 傳送者進行隔離（建議用於多帳號收件匣）。
  使用 `session.identityLinks` 將帶有供應商前綴的同伴 ID（peer ids）映射到規範身分，以便同一個人在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 時，能跨頻道共享私訊工作階段。

## 安全私訊模式（建議用於多使用者設定）

> **安全警告：** 如果您的智慧代理可以接收來自 **多個人** 的私訊，強烈建議啟用安全私訊模式。若未啟用，所有使用者將共享相同的對話內容，這可能會導致使用者之間的隱私資訊洩漏。

**預設設定的問題範例：**

- Alice（`<SENDER_A>`）傳送關於私人話題（例如預約看診）的訊息給您的智慧代理
- Bob（`<SENDER_B>`）傳送訊息詢問智慧代理：「我們剛才在聊什麼？」
- 由於兩個私訊共享同一個工作階段，模型可能會使用 Alice 先前的對話內容來回答 Bob。

**修正方法：** 設定 `dmScope` 以針對每個使用者隔離工作階段：

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // 安全私訊模式：針對每個頻道 + 傳送者隔離私訊內容。
    dmScope: "per-channel-peer",
  },
}
```

**何時應啟用此模式：**

- 配對授權超過一個傳送者
- 私訊白名單（allowlist）包含多個項目
- 設定了 `dmPolicy: "open"`
- 多個電話號碼或帳號可以傳送訊息給您的智慧代理

注意事項：

- 預設為 `dmScope: "main"` 以保持連續性（所有私訊共享主工作階段）。這適用於單一使用者設定。
- 對於同一個頻道上的多帳號收件匣，建議使用 `per-account-channel-peer`。
- 如果同一個人透過多個頻道與您聯繫，請使用 `session.identityLinks` 將他們的私訊工作階段合併為一個規範身分。
- 您可以使用 `openclaw security audit` 驗證您的私訊設定（請參閱[安全性](/cli/security)）。

## Gateway 為單一事實來源

所有工作階段狀態均由 **Gateway**（「主控」OpenClaw）擁有。UI 客戶端（macOS 應用程式、WebChat 等）必須向 Gateway 查詢工作階段列表和 Token 計數，而非讀取本地檔案。

- 在 **遠端模式** 下，您關心的工作階段儲存區位於遠端 Gateway 主機上，而非您的 Mac。
- UI 中顯示的 Token 計數來自 Gateway 儲存區欄位（`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`）。客戶端不會解析 JSONL 逐字稿來「修正」總數。

## 狀態儲存位置

- 在 **Gateway 主機** 上：
  - 儲存檔案：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（針對每個智慧代理）。
- 逐字稿：`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegram 主題工作階段使用 `.../<SessionId>-topic-<threadId>.jsonl`）。
- 儲存區是一個映射 `sessionKey -> { sessionId, updatedAt, ... }`。刪除項目是安全的；系統會根據需求重新建立。
- 群組項目可能包含 `displayName`、`channel`、`subject`、`room` 和 `space`，以便在 UI 中標記工作階段。
- 工作階段項目包含 `origin` 元數據（標籤 + 路由提示），以便 UI 說明工作階段的來源。
- OpenClaw **不會** 讀取舊版的 Pi/Tau 工作階段資料夾。

## 工作階段修剪

OpenClaw 預設會在 LLM 呼叫前從記憶體內容中修剪 **舊的工具結果**。
這 **不會** 重寫 JSONL 歷史紀錄。請參閱 [/concepts/session-pruning](/concepts/session-pruning)。

## 壓縮前記憶體清除

當工作階段接近自動壓縮時，OpenClaw 可以執行一次 **靜默記憶體清除**（silent memory flush），提醒模型將持久註記寫入磁碟。這僅在工作區可寫入時執行。請參閱 [記憶體](/concepts/memory) 與 [壓縮](/concepts/compaction)。

## 傳輸協定與工作階段鍵名的映射

- 私訊遵循 `session.dmScope`（預設為 `main`）。
  - `main`：`agent:<agentId>:<mainKey>`（跨裝置/頻道的連續性）。
    - 多個電話號碼和頻道可以映射到同一個智慧代理主鍵名；它們作為傳輸方式進入同一個對話。
  - `per-peer`：`agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`：`agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`：`agent:<agentId>:<channel>:<accountId>:dm:<peerId>`（accountId 預設為 `default`）。
  - 如果 `session.identityLinks` 與帶有供應商前綴的同伴 ID（例如 `telegram:123`）相符，規範鍵名將取代 `<peerId>`，使同一個人在跨頻道時共享工作階段。
- 群組聊天隔離狀態：`agent:<agentId>:<channel>:group:<id>`（聊天室/頻道使用 `agent:<agentId>:<channel>:channel:<id>`）。
  - Telegram 論壇主題會在群組 ID 後附加 `:topic:<threadId>` 以進行隔離。
  - 舊版的 `group:<id>` 鍵名仍可被識別以進行遷移。
- 傳入內容可能仍使用 `group:<id>`；頻道會從 `Provider` 推斷，並規範化為 `agent:<agentId>:<channel>:group:<id>` 形式。
- 其他來源：
  - 排程任務（Cron jobs）：`cron:<job.id>`
  - Webhooks：`hook:<uuid>`（除非由 hook 明確設定）
  - Node 執行：`node-<nodeId>`

## 生命週期

- 重設策略：工作階段會持續重複使用直到過期，過期評估會在下一則傳入訊息時進行。
- 每日重設：預設為 **Gateway 主機當地時間凌晨 4:00**。一旦工作階段的最後更新時間早於最近的每日重設時間，該工作階段即視為過期。
- 閒置重設（選用）：`idleMinutes` 會增加一個滑動閒置視窗。當同時設定每日重設和閒置重設時，**以先到期者為準** 來強制建立新的工作階段。
- 舊版僅閒置模式：如果您在沒有任何 `session.reset`/`resetByType` 設定的情況下設定了 `session.idleMinutes`，OpenClaw 將保持在僅閒置模式以維持向下相容性。
- 按類型覆寫（選用）：`resetByType` 讓您可以覆寫 `direct`、`group` 和 `thread` 工作階段的策略（thread = Slack/Discord 執行緒、Telegram 主題、由連接器提供的 Matrix 執行緒）。
- 按頻道覆寫（選用）：`resetByChannel` 會覆寫該頻道的工作階段重設策略（適用於該頻道的各種類型，且優先權高於 `reset`/`resetByType`）。
- 重設觸發：輸入精確的 `/new` 或 `/reset`（以及 `resetTriggers` 中的任何額外指令）會啟動新的工作階段 ID，並將訊息的其餘部分傳遞下去。`/new <model>` 接受模型別名、`provider/model` 或供應商名稱（模糊比對）以設定新工作階段的模型。如果單獨傳送 `/new` 或 `/reset`，OpenClaw 會執行簡短的「hello」問候語以確認重設。
- 手動重設：從儲存區刪除特定鍵名或移除 JSONL 逐字稿；下一則訊息會重新建立它們。
- 隔離的排程任務每次執行時都會生成全新的 `sessionId`（不重複使用閒置工作階段）。

## 傳送策略（選用）

封鎖特定工作階段類型的傳送，而無需列出各別 ID。

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

執行階段覆寫（僅限擁有者）：

- `/send on` → 此工作階段允許傳送
- `/send off` → 此工作階段拒絕傳送
- `/send inherit` → 清除覆寫並使用設定規則
  請將這些作為單獨的訊息傳送以進行註冊。

## 設定（選用重新命名範例）

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // 保持群組鍵名獨立
    dmScope: "main", // 私訊連續性（共用收件匣請設定為 per-channel-peer/per-account-channel-peer）
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // 預設：mode=daily, atHour=4 (Gateway 主機當地時間)。
      // 如果您同時設定了 idleMinutes，則以先到期者為準。
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
- `openclaw sessions --json` — 傾印所有項目（使用 `--active <分鐘數>` 進行過濾）。
- `openclaw gateway call sessions.list --params '{}'` — 從執行中的 Gateway 獲取工作階段列表（使用 `--url`/`--token` 存取遠端 Gateway）。
- 在對話中單獨傳送 `/status` 訊息以查看智慧代理是否可供連線、工作階段內容已使用多少、目前的思考/詳細模式切換狀態，以及您的 WhatsApp 網頁版憑證上次重新整理的時間（有助於發現是否需要重新連結）。
- 傳送 `/context list` 或 `/context detail` 以查看系統提示語（system prompt）和插入的工作區檔案（以及對內容貢獻最多的來源）。
- 單獨傳送 `/stop` 訊息以中止目前的執行、清除該工作階段已排程的後續任務，並停止從中衍生的任何子代理執行（回覆內容包含已停止的計數）。
- 單獨傳送 `/compact`（可選指令）訊息以總結較舊的內容並釋放視窗空間。請參閱 [/concepts/compaction](/concepts/compaction)。
- JSONL 逐字稿可以直接開啟以檢視完整的對話輪次。

## 提示

- 讓主鍵名專用於 1 對 1 通訊；讓群組保有自己的鍵名。
- 執行自動清理時，請刪除個別鍵名而非整個儲存區，以保留其他地方的內容。

## 工作階段來源元數據

每個工作階段項目都會在 `origin` 中記錄其來源（盡力而為）：

- `label`：人類可讀的標籤（從對話標籤 + 群組主題/頻道解析）
- `provider`：規範化的頻道 ID（包含擴充功能）
- `from`/`to`：來自傳入信封的原始路由 ID
- `accountId`：供應商帳號 ID（多帳號時）
- `threadId`：當頻道支援時的執行緒/主題 ID
  `origin` 欄位適用於私訊、頻道和群組。如果連接器僅更新傳送路由（例如為了保持私訊主工作階段的即時性），它仍應提供傳入內容，以便工作階段保留其解釋性元數據。擴充功能可以透過在傳入內容中傳送 `ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace` 和 `SenderName` 並呼叫 `recordSessionMetaFromInbound`（或將相同內容傳遞給 `updateLastRoute`）來實現此功能。
