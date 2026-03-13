---
summary: "Session management rules, keys, and persistence for chats"
read_when:
  - Modifying session handling or storage
title: Session Management
---

# Session Management

OpenClaw 將 **每個代理的直接聊天會話** 視為主要會話。直接聊天會話會合併為 `agent:<agentId>:<mainKey>`（預設為 `main`），而群組/頻道聊天則會獲得自己的鍵。`session.mainKey` 會被尊重。

使用 `session.dmScope` 來控制 **直接訊息** 的分組方式：

- `main` (預設): 所有的直接訊息共享主要會話以保持連貫性。
- `per-peer`: 根據發送者 ID 在各通道中隔離。
- `per-channel-peer`: 根據通道 + 發送者隔離（建議用於多用戶收件箱）。
- `per-account-channel-peer`: 根據帳戶 + 通道 + 發送者隔離（建議用於多帳戶收件箱）。
  使用 `session.identityLinks` 將提供者前綴的對等 ID 映射到標準身份，以便在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 時，同一個人可以在各通道中共享直接訊息會話。

## 安全 DM 模式（建議用於多用戶設置）

> **安全警告：** 如果您的代理可以接收來自 **多個人** 的私訊，您應該強烈考慮啟用安全私訊模式。若不啟用，所有用戶將共享相同的對話上下文，這可能會導致用戶之間洩漏私人資訊。

**預設設定的問題範例：**

- Alice (`<SENDER_A>`) 向你的代理發送有關私人主題的訊息（例如，醫療約診）
- Bob (`<SENDER_B>`) 向你的代理發送訊息詢問「我們在談什麼？」
- 因為這兩個直接訊息共享相同的會話，模型可能會使用 Alice 之前的上下文來回答 Bob。

**修正方法：** 設定 `dmScope` 以隔離每位使用者的會話：

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

- 您有多個發送者的配對批准
- 您使用包含多個條目的 DM 允許清單
- 您設置了 `dmPolicy: "open"`
- 多個電話號碼或帳戶可以發送訊息給您的代理人

[[BLOCK_1]]

- 預設為 `dmScope: "main"` 以保持連續性（所有 DM 共享主要會話）。這對於單用戶設置來說是可以的。
- 當未設置時，本地 CLI 上線預設寫入 `session.dmScope: "per-channel-peer"`（現有的明確值會被保留）。
- 對於在同一頻道上的多帳戶收件箱，建議使用 `per-account-channel-peer`。
- 如果同一個人通過多個頻道聯繫你，請使用 `session.identityLinks` 將他們的 DM 會話合併為一個標準身份。
- 你可以使用 `openclaw security audit` 驗證你的 DM 設置（請參見 [security](/cli/security)）。

## Gateway 是真相的來源

所有會話狀態**由網關擁有**（“主” OpenClaw）。UI 用戶端（macOS 應用程式、WebChat 等）必須查詢網關以獲取會話列表和 token 數量，而不是讀取本地檔案。

- 在 **遠端模式** 中，您關心的會話儲存位於遠端閘道主機上，而不是您的 Mac。
- 在使用者介面中顯示的 token 數量來自閘道的儲存欄位 (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`)。用戶端不會解析 JSONL 轉錄以“修正”總數。

## 狀態的所在

- 在 **閘道主機** 上：
  - 儲存檔案：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（每個代理）。
- 逐字稿：`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegram 主題會話使用 `.../<SessionId>-topic-<threadId>.jsonl`）。
- 儲存區是一個映射 `sessionKey -> { sessionId, updatedAt, ... }`。刪除條目是安全的；它們會根據需求重新創建。
- 群組條目可能包括 `displayName`、`channel`、`subject`、`room` 和 `space` 以標記 UI 中的會話。
- 會話條目包括 `origin` 元數據（標籤 + 路由提示），以便 UI 可以解釋會話的來源。
- OpenClaw **不** 讀取舊版 Pi/Tau 會話資料夾。

## Maintenance

OpenClaw 應用會話存儲維護，以保持 `sessions.json` 和轉錄工件隨時間的界限。

### Defaults

- `session.maintenance.mode`: `warn`
- `session.maintenance.pruneAfter`: `30d`
- `session.maintenance.maxEntries`: `500`
- `session.maintenance.rotateBytes`: `10mb`
- `session.maintenance.resetArchiveRetention`: 預設為 `pruneAfter` (`30d`)
- `session.maintenance.maxDiskBytes`: 未設定（已禁用）
- `session.maintenance.highWaterBytes`: 當預算功能啟用時，預設為 `80%` 的 `maxDiskBytes`

### 它是如何運作的

在 session-store 寫入期間會進行維護，您可以透過 `openclaw sessions cleanup` 按需觸發它。

- `mode: "warn"`: 報告將被驅逐的專案，但不會改變條目/記錄。
- `mode: "enforce"`: 依照以下順序執行清理：
  1. 剔除超過 `pruneAfter` 的過期條目
  2. 將條目數量限制為 `maxEntries`（最舊的優先）
  3. 對於不再被引用的已移除條目，存檔記錄檔案
  4. 根據保留政策清除舊的 `*.deleted.<timestamp>` 和 `*.reset.<timestamp>` 存檔
  5. 當 `sessions.json` 超過 `rotateBytes` 時進行輪替
  6. 如果設定了 `maxDiskBytes`，則根據 `highWaterBytes` 強制執行磁碟預算（最舊的工件優先，然後是最舊的會話）

### 大型商店的性能警告

大型會話儲存通常在高流量的設置中很常見。維護工作屬於寫入路徑的工作，因此非常大的儲存會增加寫入延遲。

[[BLOCK_1]]

- 非常高的 `session.maintenance.maxEntries` 值
- 長時間的 `pruneAfter` 窗口，保留過時的條目
- 許多在 `~/.openclaw/agents/<agentId>/sessions/` 中的轉錄/存檔工件
- 啟用磁碟預算 (`maxDiskBytes`) 而沒有合理的修剪/容量限制

[[BLOCK_1]]

- 在生產環境中使用 `mode: "enforce"`，以便自動限制增長
- 設定時間和計數限制 (`pruneAfter` + `maxEntries`), 而不僅僅是一個
- 在大型部署中設定 `maxDiskBytes` + `highWaterBytes` 以獲得硬性上限
- 使 `highWaterBytes` 明顯低於 `maxDiskBytes` (預設為 80%)
- 在設定變更後執行 `openclaw sessions cleanup --dry-run --json` 以驗證預期影響，然後再強制執行
- 對於頻繁的活躍會話，在手動清理時傳遞 `--active-key`

### 自訂範例

使用保守的強制政策：

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

啟用會話目錄的硬碟預算：

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

調整以適應較大的安裝（範例）：

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

## Session pruning

OpenClaw 會在 LLM 調用之前，預設從記憶體上下文中修剪 **舊工具結果**。這並不會重寫 JSONL 歷史。請參見 [/concepts/session-pruning](/concepts/session-pruning)。

## 預壓縮記憶體清空

當會話接近自動壓縮時，OpenClaw 可以執行一個 **靜默記憶體清除**，提醒模型將持久性筆記寫入磁碟。這僅在工作區可寫入時執行。請參閱 [Memory](/concepts/memory) 和 [Compaction](/concepts/compaction)。

## 對應傳輸 → 會話金鑰

- 直接聊天遵循 `session.dmScope` (預設 `main`)。
  - `main`: `agent:<agentId>:<mainKey>` (在設備/通道之間的連續性)。
    - 多個電話號碼和通道可以映射到同一代理主鍵；它們作為進入同一對話的傳輸。
  - `per-peer`: `agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId 預設為 `default`)。
  - 如果 `session.identityLinks` 與提供者前綴的對等 ID 匹配 (例如 `telegram:123`), 則標準鍵會替換 `<peerId>`，使同一個人能夠在不同通道之間共享會話。
- 群組聊天隔離狀態: `agent:<agentId>:<channel>:group:<id>` (房間/通道使用 `agent:<agentId>:<channel>:channel:<id>`)。
  - Telegram 論壇主題將 `:topic:<threadId>` 附加到群組 ID 以進行隔離。
  - 過時的 `group:<id>` 鍵仍然被識別以便於遷移。
- 入站上下文仍然可以使用 `group:<id>`；通道是從 `Provider` 推斷的，並標準化為標準 `agent:<agentId>:<channel>:group:<id>` 形式。
- 其他來源：
  - Cron 工作: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (除非由 webhook 明確設置)
  - Node 執行: `node-<nodeId>`

## Lifecycle

- 重置政策：會話在過期之前會被重複使用，過期時間會在下一個進入的訊息中進行評估。
- 每日重置：預設為 **網關主機當地時間的凌晨 4:00**。一旦會話的最後更新時間早於最近的每日重置時間，則該會話被視為過期。
- 空閒重置（可選）：`idleMinutes` 添加了一個滑動的空閒窗口。當同時設定每日和空閒重置時，**先過期的重置**會強制建立新的會話。
- 傳統的僅空閒模式：如果您設置 `session.idleMinutes` 而不包含任何 `session.reset`/`resetByType` 設定，OpenClaw 將保持在僅空閒模式，以保持向後相容性。
- 每類型覆蓋（可選）：`resetByType` 允許您覆蓋 `direct`、`group` 和 `thread` 會話的政策（thread = Slack/Discord 線程、Telegram 主題、Matrix 線程，當由連接器提供時）。
- 每頻道覆蓋（可選）：`resetByChannel` 覆蓋某個頻道的重置政策（適用於該頻道的所有會話類型，並優先於 `reset`/`resetByType`）。
- 重置觸發器：精確的 `/new` 或 `/reset`（加上 `resetTriggers` 中的任何額外內容）會啟動一個新的會話 ID 並傳遞其餘的訊息。`/new <model>` 接受模型別名、`provider/model` 或提供者名稱（模糊匹配）來設置新的會話模型。如果單獨發送 `/new` 或 `/reset`，OpenClaw 會執行一個簡短的“你好”問候回合以確認重置。
- 手動重置：從存儲中刪除特定鍵或移除 JSONL 轉錄；下一條訊息將重新創建它們。
- 隔離的 cron 工作每次執行都會生成一個新的 `sessionId`（不重複使用空閒）。

## Send policy (optional)

[[BLOCK_N]] 對於特定會話類型進行封鎖交付，而無需列出個別 ID。 [[BLOCK_N]]

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

[[BLOCK_N]]  
Runtime override (owner only):  
[[INLINE_N]]

- `/send on` → 允許此會話
- `/send off` → 拒絕此會話
- `/send inherit` → 清除覆蓋並使用設定規則  
  將這些作為獨立訊息發送，以便它們能夠註冊。

## 設定（可選的重新命名範例）

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

## Inspecting

- `openclaw status` — 顯示商店路徑和最近的會話。
- `openclaw sessions --json` — 傳送每個條目（使用 `--active <minutes>` 進行過濾）。
- `openclaw gateway call sessions.list --params '{}'` — 從正在執行的網關獲取會話（使用 `--url`/`--token` 進行遠端網關訪問）。
- 發送 `/status` 作為獨立訊息在聊天中，以查看代理是否可達、會話上下文的使用量、當前思考/快速/詳細切換，以及您的 WhatsApp 網頁憑證最後一次更新的時間（有助於發現重新連結的需求）。
- 發送 `/context list` 或 `/context detail` 以查看系統提示和注入的工作區檔案中的內容（以及最大的上下文貢獻者）。
- 發送 `/stop`（或獨立的中止短語，如 `stop`、`stop action`、`stop run`、`stop openclaw`）以中止當前執行，清除該會話的排隊後續，並停止從中產生的任何子代理執行（回覆中包含已停止的計數）。
- 發送 `/compact`（可選指令）作為獨立訊息，以總結較舊的上下文並釋放視窗空間。請參見 [/concepts/compaction](/concepts/compaction)。
- JSONL 轉錄可以直接打開以查看完整的回合。

## Tips

- 將主鍵專用於 1:1 流量；讓群組保留自己的鍵。
- 在自動化清理時，刪除個別鍵而不是整個存儲，以保留其他地方的上下文。

## Session origin metadata

每個會話條目記錄其來源（最佳努力）在 `origin`:

- `label`: 人類標籤（從對話標籤 + 群組主題/頻道解析而來）
- `provider`: 正規化的頻道 ID（包括擴充）
- `from`/`to`: 來自入站信封的原始路由 ID
- `accountId`: 提供者帳戶 ID（當有多個帳戶時）
- `threadId`: 當頻道支援時的主題/主題 ID  
  原始欄位會在直接消息、頻道和群組中填充。如果連接器僅更新交付路由（例如，為了保持 DM 主要會話的最新狀態），它仍然應提供入站上下文，以便會話保持其解釋者元數據。擴充可以通過在入站上下文中發送 `ConversationLabel`、`GroupSubject`、`GroupChannel`、`GroupSpace` 和 `SenderName`，並調用 `recordSessionMetaFromInbound`（或將相同的上下文傳遞給 `updateLastRoute`）來做到這一點。
