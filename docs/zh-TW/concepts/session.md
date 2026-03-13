---
summary: "Session management rules, keys, and persistence for chats"
read_when:
  - Modifying session handling or storage
title: Session Management
---

# 會話管理

OpenClaw 將 **每個代理的一對一直接聊天會話** 視為主要會話。直接聊天會合併到 `agent:<agentId>:<mainKey>`（預設為 `main`），而群組/頻道聊天則有自己的鍵。`session.mainKey` 會被遵守。

使用 `session.dmScope` 來控制 **直接訊息** 的分組方式：

- `main`（預設）：所有直接訊息共用主要會話以保持連續性。
- `per-peer`：依發送者 ID 跨頻道隔離。
- `per-channel-peer`：依頻道 + 發送者隔離（建議用於多使用者收件匣）。
- `per-account-channel-peer`：依帳號 + 頻道 + 發送者隔離（建議用於多帳號收件匣）。
  使用 `session.identityLinks` 將帶有提供者前綴的對等 ID 映射為標準身份，讓同一人在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 時，跨頻道共用同一直接訊息會話。

## 安全直接訊息模式（建議用於多使用者環境）

> **安全警告：** 如果您的代理能接收來自 **多個人** 的直接訊息，強烈建議啟用安全直接訊息模式。若未啟用，所有使用者將共用相同的對話上下文，可能導致使用者間私密資訊外洩。

**預設設定問題範例：**

- Alice (`<SENDER_A>`) 傳送關於私人議題（例如醫療預約）的訊息給您的代理
- Bob (`<SENDER_B>`) 傳訊息問「我們剛剛在聊什麼？」
- 因為兩個直接訊息共用同一會話，模型可能會用 Alice 之前的上下文回覆 Bob。

**解決方法：** 將 `dmScope` 設定為依使用者隔離會話：

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**何時啟用此功能：**

- 您有多個發送者的配對授權
- 您使用包含多筆條目的直接訊息允許清單
- 您設定了 `dmPolicy: "open"`
- 多個電話號碼或帳號能傳訊息給您的代理

注意事項：

- 預設為 `dmScope: "main"` 以保持連續性（所有直接訊息共用主要會話）。這對單一使用者環境適用。
- 本地 CLI 新增時，若未設定，預設寫入 `session.dmScope: "per-channel-peer"`（現有明確值會被保留）。
- 同一頻道多帳號收件匣，建議使用 `per-account-channel-peer`。
- 若同一人在多個頻道聯絡您，使用 `session.identityLinks` 將其直接訊息會話合併為一個標準身份。
- 您可以使用 `openclaw security audit` 驗證您的直接訊息設定（詳見 [security](/cli/security)）。

## Gateway 是真實資料來源

所有的會話狀態皆由 **gateway**（即「主控」OpenClaw）擁有。UI 用戶端（macOS 應用程式、WebChat 等）必須向 gateway 查詢會話列表和 token 數量，而非讀取本地檔案。

- 在 **遠端模式** 下，您關心的會話存儲位於遠端 gateway 主機，而非您的 Mac。
- UI 顯示的 token 數量來自 gateway 的存儲欄位 (`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`)。用戶端不會解析 JSONL 文字記錄來「修正」總數。

## 狀態存放位置

- 在 **gateway 主機** 上：
  - 存儲檔案：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（每個代理）。
- 文字記錄：`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegram 主題會話使用 `.../<SessionId>-topic-<threadId>.jsonl`）。
- 存儲是一個映射 `sessionKey -> { sessionId, updatedAt, ... }`。刪除條目是安全的；它們會按需重新建立。
- 群組條目可能包含 `displayName`、`channel`、`subject`、`room` 和 `space`，用於在 UI 中標示會話。
- 會話條目包含 `origin` 元資料（標籤 + 路由提示），讓 UI 能說明會話來源。
- OpenClaw **不會**讀取舊版 Pi/Tau 會話資料夾。

## 維護

OpenClaw 會對會話存儲進行維護，以確保 `sessions.json` 和文字記錄檔案隨時間保持在合理範圍內。

### 預設值

- `session.maintenance.mode`：`warn`
- `session.maintenance.pruneAfter`：`30d`
- `session.maintenance.maxEntries`：`500`
- `session.maintenance.rotateBytes`：`10mb`
- `session.maintenance.resetArchiveRetention`：預設為 `pruneAfter`（`30d`）
- `session.maintenance.maxDiskBytes`：未設定（停用）
- `session.maintenance.highWaterBytes`：啟用預算時預設為 `80%` 的 `maxDiskBytes`

### 運作方式

維護會在會話存儲寫入時執行，您也可以使用 `openclaw sessions cleanup` 隨時觸發。

- `mode: "warn"`：報告將被清除的專案，但不會修改條目或文字記錄。
- `mode: "enforce"`：依序執行清理：
  1. 修剪超過 `pruneAfter` 的過期條目
  2. 將條目數量限制在 `maxEntries`（先刪除最舊）
  3. 將不再被引用的已刪除條目文字記錄檔案歸檔
  4. 根據保留政策清除舊的 `*.deleted.<timestamp>` 和 `*.reset.<timestamp>` 歸檔
  5. 當 `sessions.json` 超過 `rotateBytes` 時進行輪替
  6. 若設定 `maxDiskBytes`，則依 `highWaterBytes` 強制執行磁碟空間預算（先清除最舊的檔案，再清除最舊的會話）

### 大型存儲的效能注意事項

大型會話存儲在高流量環境中很常見。維護工作屬於寫入路徑作業，因此非常大的存儲可能會增加寫入延遲。

最影響成本的因素：

- 非常高的 `session.maintenance.maxEntries` 數值
- 長時間的 `pruneAfter` 窗口，導致過期條目持續存在
- `~/.openclaw/agents/<agentId>/sessions/` 中大量的文字記錄／歸檔檔案
- 啟用磁碟預算 (`maxDiskBytes`)，但未設定合理的修剪或上限

要做的事：

- 在生產環境中使用 `mode: "enforce"`，以自動限制成長
- 同時設定時間和次數限制（`pruneAfter` + `maxEntries`），而非只設定其中一項
- 在大型部署中設定 `maxDiskBytes` + `highWaterBytes` 作為硬性上限
- 將 `highWaterBytes` 保持在 `maxDiskBytes` 以下有意義的水準（預設為 80%）
- 在強制執行前，於設定變更後執行 `openclaw sessions cleanup --dry-run --json` 以驗證預期影響
- 對於頻繁的活躍會話，執行手動清理時傳入 `--active-key`

### 自訂範例

使用保守的強制策略：

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "45d",
      maxEntries: 800,
      rotateBytes: "20mb",
      resetArchiveRetention: "14d",
    },
  },
}
```

為 sessions 目錄啟用硬碟配額：

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      maxDiskBytes: "1gb",
      highWaterBytes: "800mb",
    },
  },
}
```

針對較大型安裝進行調整（範例）：

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "14d",
      maxEntries: 2000,
      rotateBytes: "25mb",
      maxDiskBytes: "2gb",
      highWaterBytes: "1.6gb",
    },
  },
}
```

從 CLI 預覽或強制維護：

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

## 會話修剪

OpenClaw 預設會在 LLM 呼叫前，從記憶體上下文中修剪**舊的工具結果**。
這不會重寫 JSONL 歷史。詳見 [/concepts/session-pruning](/concepts/session-pruning)。

## 預壓縮記憶體刷新

當會話接近自動壓縮時，OpenClaw 可以執行一個**靜默記憶體刷新**，
提醒模型將持久化的筆記寫入磁碟。此操作僅在工作區可寫時執行。詳見 [Memory](/concepts/memory) 與
[Compaction](/concepts/compaction)。

## 映射傳輸 → 會話金鑰

- 直接聊天遵循 `session.dmScope`（預設 `main`）。
  - `main`：`agent:<agentId>:<mainKey>`（跨裝置/頻道持續性）。
    - 多個電話號碼和頻道可以映射到同一代理主金鑰；它們作為進入同一對話的傳輸。
  - `per-peer`：`agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`：`agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`：`agent:<agentId>:<channel>:<accountId>:dm:<peerId>`（accountId 預設為 `default`）。
  - 如果 `session.identityLinks` 符合帶有提供者前綴的對等 ID（例如 `telegram:123`），則正規金鑰會取代 `<peerId>`，使同一人跨頻道共享會話。
- 群組聊天隔離狀態：`agent:<agentId>:<channel>:group:<id>`（房間/頻道使用 `agent:<agentId>:<channel>:channel:<id>`）。
  - Telegram 論壇主題會在群組 ID 後附加 `:topic:<threadId>` 以實現隔離。
  - 舊版 `group:<id>` 金鑰仍被識別以便遷移。
- 進站上下文仍可能使用 `group:<id>`；頻道從 `Provider` 推斷並標準化為正規 `agent:<agentId>:<channel>:group:<id>` 形式。
- 其他來源：
  - 定時任務：`cron:<job.id>`
  - Webhooks：`hook:<uuid>`（除非由 webhook 明確設定）
  - Node 執行：`node-<nodeId>`

## 生命週期

- 重置政策：會話會重複使用直到過期，過期判斷在下一則進站訊息時進行。
- 每日重置：預設為 **閘道主機當地時間凌晨 4:00**。當會話最後更新時間早於最近的每日重置時間，即視為陳舊。
- 閒置重置（可選）：`idleMinutes` 新增滑動閒置視窗。當每日與閒置重置同時設定時，**以先到期者為準**，強制啟用新會話。
- 舊版僅閒置模式：若設定 `session.idleMinutes` 但未設定任何 `session.reset`/`resetByType`，OpenClaw 將維持舊版閒置模式以保持相容。
- 類型別覆寫（可選）：`resetByType` 允許覆寫 `direct`、`group` 和 `thread` 會話的政策（thread 指 Slack/Discord 線程、Telegram 主題、Matrix 線程，視連接器提供而定）。
- 頻道別覆寫（可選）：`resetByChannel` 覆寫該頻道的重置政策（適用於該頻道所有會話類型，且優先於 `reset`/`resetByType`）。
- 重置觸發：精確 `/new` 或 `/reset`（加上 `resetTriggers` 中的任何額外專案）會啟動新會話 ID，並將訊息剩餘部分繼續傳遞。`/new <model>` 可接受模型別名、`provider/model` 或提供者名稱（模糊匹配）來設定新會話模型。若單獨發送 `/new` 或 `/reset`，OpenClaw 會執行短暫的「hello」問候回合以確認重置。
- 手動重置：刪除儲存中的特定金鑰或移除 JSONL 記錄；下一則訊息會重新建立它們。
- 隔離定時任務每次執行都會產生新的 `sessionId`（不重複使用閒置會話）。

## 傳送政策（可選）

阻擋特定會話類型的傳送，無需列出個別 ID。

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
        // Match the raw session key (including the `agent:<id>:` prefix).
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ],
      default: "allow",
    },
  },
}
```

執行時覆寫（僅限擁有者）：

- `/send on` → 允許此會話
- `/send off` → 拒絕此會話
- `/send inherit` → 清除覆寫並使用設定規則
  請以獨立訊息發送以確保註冊。

## 設定（可選重新命名範例）

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
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

## 檢視

- `openclaw status` — 顯示儲存路徑與近期會話。
- `openclaw sessions --json` — 傾印所有條目（可用 `--active <minutes>` 過濾）。
- `openclaw gateway call sessions.list --params '{}'` — 從執行中的閘道擷取會話（遠端閘道存取請用 `--url`/`--token`）。
- 在聊天中以獨立訊息發送 `/status`，查看代理是否可達、會話上下文使用量、目前思考/快速/詳細切換狀態，以及 WhatsApp 網頁憑證最後刷新時間（有助於判斷是否需重新連結）。
- 發送 `/context list` 或 `/context detail` 查看系統提示與注入的工作區檔案內容（及最大上下文貢獻者）。
- 發送 `/stop`（或獨立中止語句如 `stop`、`stop action`、`stop run`、`stop openclaw`）可中止當前執行，清除該會話的排隊後續，並停止由其衍生的子代理執行（回覆會包含停止數量）。
- 發送 `/compact`（可選指令）作為獨立訊息，摘要舊上下文並釋放視窗空間。詳見 [/concepts/compaction](/concepts/compaction)。
- JSONL 記錄可直接開啟以檢視完整回合。

## 小技巧

- 保持主金鑰專用於一對一流量；讓群組保有自己的金鑰。
- 自動清理時，刪除單一金鑰而非整個儲存，以保留其他處的上下文。

## 會話來源元資料

每個會話條目會記錄其來源（盡力而為）於 `origin`：

- `label`：人工標籤（由對話標籤 + 群組主題/頻道解析而來）
- `provider`：標準化頻道 ID（包含擴充）
- `from`/`to`：來自入站信封的原始路由 ID
- `accountId`：提供者帳號 ID（多帳號時）
- `threadId`：當頻道支援時的主題/討論串 ID  
  來源欄位會填入直接訊息、頻道及群組。如果連接器僅更新傳遞路由（例如，為了保持 DM 主要會話的新鮮度），仍應提供入站上下文，以便會話保有其說明元資料。擴充功能可透過在入站上下文中傳送 `ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace` 及 `SenderName`，並呼叫 `recordSessionMetaFromInbound`（或將相同上下文傳給 `updateLastRoute`）來達成此目的。
