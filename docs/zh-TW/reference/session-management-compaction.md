---
summary: >-
  Deep dive: session store + transcripts, lifecycle, and (auto)compaction
  internals
read_when:
  - "You need to debug session ids, transcript JSONL, or sessions.json fields"
  - >-
    You are changing auto-compaction behavior or adding “pre-compaction”
    housekeeping
  - You want to implement memory flushes or silent system turns
title: Session Management Deep Dive
---

# 會話管理與壓縮（深入解析）

本文檔說明 OpenClaw 如何端到端管理會話：

- **會話路由**（入站訊息如何映射到 `sessionKey`）
- **會話存儲**（`sessions.json`）及其追蹤內容
- **對話記錄持久化**（`*.jsonl`）及其結構
- **對話記錄清理**（執行前的供應商特定修正）
- **上下文限制**（上下文視窗與追蹤的 token 數量）
- **壓縮**（手動與自動壓縮）及預壓縮工作掛鉤位置
- **靜默維護**（例如不應產生使用者可見輸出的記憶體寫入）

如果你想先了解較高層次的概覽，請參考：

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## 真實資料來源：Gateway

OpenClaw 是以單一 **Gateway 程序** 為核心設計，該程序擁有會話狀態。

- UI（macOS 應用程式、網頁控制 UI、文字介面）應向 Gateway 查詢會話列表與 token 計數。
- 在遠端模式下，會話檔案存放於遠端主機；「檢查你本地 Mac 的檔案」不會反映 Gateway 正在使用的狀態。

---

## 兩層持久化

OpenClaw 以兩層方式持久化會話：

1. **會話存儲 (`sessions.json`)**
   - 鍵值映射：`sessionKey -> SessionEntry`
   - 體積小、可變且安全編輯（或刪除條目）
   - 追蹤會話元資料（當前會話 ID、最後活動時間、切換狀態、token 計數器等）

2. **對話記錄 (`<sessionId>.jsonl`)**
   - 附加式對話記錄，具樹狀結構（條目包含 `id` + `parentId`）
   - 儲存實際對話內容、工具呼叫與壓縮摘要
   - 用於重建未來回合的模型上下文

---

## 磁碟上的位置

每個代理程式，在 Gateway 主機上：

- 儲存庫：`~/.openclaw/agents/<agentId>/sessions/sessions.json`
- 文字記錄：`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram 主題會話：`.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw 透過 `src/config/sessions.ts` 來解析這些位置。

---

## 儲存庫維護與磁碟控制

會話持久化具有自動維護控制 (`session.maintenance`)，用於 `sessions.json` 和文字記錄檔案：

- `mode`：`warn`（預設）或 `enforce`
- `pruneAfter`：過期條目年齡截止（預設 `30d`）
- `maxEntries`：限制 `sessions.json` 中的條目數量（預設 `500`）
- `rotateBytes`：當超過大小時輪替 `sessions.json`（預設 `10mb`）
- `resetArchiveRetention`：`*.reset.<timestamp>` 文字記錄檔案的保留期限（預設與 `pruneAfter` 相同；`false` 禁用清理）
- `maxDiskBytes`：可選的會話目錄磁碟空間預算
- `highWaterBytes`：清理後的目標值（預設為 `80%` 的 `maxDiskBytes`）

磁碟空間預算清理的執行順序 (`mode: "enforce"`)：

1. 先移除最舊的已封存或孤立文字記錄檔案。
2. 若仍超過目標，則驅逐最舊的會話條目及其文字記錄檔案。
3. 持續執行直到使用量達到或低於 `highWaterBytes`。

在 `mode: "warn"` 中，OpenClaw 會報告潛在的驅逐，但不會更動儲存庫或檔案。

隨時執行維護：

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

---

## 定時會話與執行日誌

孤立的 cron 執行也會建立會話條目/對話記錄，並且它們有專屬的保留控制：

- `cron.sessionRetention`（預設為 `24h`）會從會話存儲中修剪舊的孤立 cron 執行會話（`false` 可停用）。
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` 會修剪 `~/.openclaw/cron/runs/<jobId>.jsonl` 檔案（預設值：`2_000_000` 位元組和 `2000` 行）。

---

## 會話鍵 (`sessionKey`)

`sessionKey` 用來識別 _你所在的對話桶_（路由與隔離）。

常見模式：

- 主要/直接聊天（每個代理人）：`agent:<agentId>:<mainKey>`（預設為 `main`）
- 群組：`agent:<agentId>:<channel>:group:<id>`
- 房間/頻道（Discord/Slack）：`agent:<agentId>:<channel>:channel:<id>` 或 `...:room:<id>`
- Cron：`cron:<job.id>`
- Webhook：`hook:<uuid>`（除非被覆寫）

正式規則記載於 [/concepts/session](/concepts/session)。

---

## 會話 ID (`sessionId`)

每個 `sessionKey` 指向一個當前的 `sessionId`（持續對話的對話記錄檔案）。

經驗法則：

- **重置**（`/new`、`/reset`）會為該 `sessionKey` 建立新的 `sessionId`。
- **每日重置**（預設為閘道主機當地時間凌晨 4:00）會在重置界線後的下一則訊息時建立新的 `sessionId`。
- **閒置過期**（`session.reset.idleMinutes` 或舊版 `session.idleMinutes`）會在閒置時間窗後收到訊息時建立新的 `sessionId`。當每日與閒置過期同時設定時，以先到期者為準。
- **執行緒父項分叉保護**（`session.parentForkMaxTokens`，預設 `100000`）會在父會話已過大時跳過父對話記錄分叉；新執行緒將從頭開始。設定 `0` 可停用此功能。

實作細節：決策發生在 `initSessionState()` 的 `src/auto-reply/reply/session.ts` 中。

---

## 會話存儲結構 (`sessions.json`)

該存儲的值類型為 `SessionEntry`，位於 `src/config/sessions.ts`。

關鍵欄位（非完整列表）：

- `sessionId`：當前對話記錄 ID（檔名由此衍生，除非設定了 `sessionFile`）
- `updatedAt`：最後活動時間戳
- `sessionFile`：可選的明確對話記錄路徑覆寫
- `chatType`：`direct | group | room`（協助 UI 和發送策略）
- `provider`、`subject`、`room`、`space`、`displayName`：群組/頻道標籤的元資料
- 切換開關：
  - `thinkingLevel`、`verboseLevel`、`reasoningLevel`、`elevatedLevel`
  - `sendPolicy`（每會話覆寫）
- 模型選擇：
  - `providerOverride`、`modelOverride`、`authProfileOverride`
- Token 計數器（盡力而為 / 依提供者而定）：
  - `inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`
- `compactionCount`：此會話鍵自動壓縮完成的次數
- `memoryFlushAt`：上次預壓縮記憶體刷新時間戳
- `memoryFlushCompactionCount`：上次刷新時的壓縮計數

該存儲可安全編輯，但 Gateway 是權威：它可能在會話執行時重寫或重新載入條目。

---

## 對話記錄結構 (`*.jsonl`)

對話記錄由 `@mariozechner/pi-coding-agent` 的 `SessionManager` 管理。

檔案格式為 JSONL：

- 第一行：會話標頭（`type: "session"`，包含 `id`、`cwd`、`timestamp`，可選 `parentSession`）
- 接著：包含 `id` + `parentId`（樹狀結構）的會話條目

重要條目類型：

- `message`：使用者／助理／工具結果訊息
- `custom_message`：擴充注入且會進入模型上下文的訊息（可從 UI 隱藏）
- `custom`：擴充狀態，不會進入模型上下文
- `compaction`：持久化的壓縮摘要，包含 `firstKeptEntryId` 和 `tokensBefore`
- `branch_summary`：瀏覽樹狀分支時的持久化摘要

OpenClaw 故意不會「修正」對話記錄；Gateway 使用 `SessionManager` 來讀寫它們。

---

## 上下文視窗與追蹤的 token

兩個不同的概念很重要：

1. **模型上下文視窗**：每個模型的硬性上限（模型可見的 token 數量）
2. **會話儲存計數器**：滾動統計數據寫入 `sessions.json`（用於 /status 和儀表板）

如果你正在調整限制：

- 上下文視窗來自模型目錄（且可透過設定覆寫）。
- 儲存中的 `contextTokens` 是執行時的估算/報告值；不要將其視為嚴格保證。

更多資訊請參考 [/token-use](/reference/token-use)。

---

## 壓縮：是什麼

壓縮會將較舊的對話摘要成持久化的 `compaction` 條目，並保留近期訊息不變。

壓縮後，未來的回合會看到：

- 壓縮摘要
- `firstKeptEntryId` 之後的訊息

壓縮是**持久化的**（不同於會話修剪）。詳見 [/concepts/session-pruning](/concepts/session-pruning)。

---

## 何時會自動壓縮（Pi 執行時）

在內嵌的 Pi 代理中，自動壓縮會在兩種情況觸發：

1. **溢位回復**：模型回傳上下文溢位錯誤 → 壓縮 → 重試。
2. **閾值維護**：成功回合後，當：

`contextTokens > contextWindow - reserveTokens`

說明：

- `contextWindow` 是模型的上下文視窗
- `reserveTokens` 是為提示詞和下一次模型輸出保留的空間

這是 Pi 執行時的語意（OpenClaw 消耗事件，但由 Pi 決定何時進行壓縮）。

---

## 壓縮設定 (`reserveTokens`, `keepRecentTokens`)

Pi 的壓縮設定位於 Pi 設定中：

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw 也會對嵌入式執行設定安全下限：

- 如果 `compaction.reserveTokens < reserveTokensFloor`，OpenClaw 會將其調高。
- 預設下限為 `20000` 個 token。
- 設定 `agents.defaults.compaction.reserveTokensFloor: 0` 可關閉此下限。
- 如果已經高於此值，OpenClaw 則不會更動。

原因：在壓縮不可避免前，保留足夠空間以支援多回合的「維護作業」（例如記憶寫入）。

實作：`ensurePiCompactionReserveTokens()` 位於 `src/agents/pi-settings.ts`（由 `src/agents/pi-embedded-runner.ts` 呼叫）。

---

## 使用者可見介面

你可以透過以下方式觀察壓縮與會話狀態：

- `/status`（在任何聊天會話中）
- `openclaw status`（CLI）
- `openclaw sessions` / `sessions --json`
- 詳細模式：`🧹 Auto-compaction complete` + 壓縮計數

---

## 靜默維護 (`NO_REPLY`)

OpenClaw 支援用於背景任務的「靜默」回合，使用者不會看到中間輸出。

慣例：

- 助理的輸出以 `NO_REPLY` 開頭，表示「不向使用者回覆」。
- OpenClaw 在傳遞層會剝除/抑制此標記。

從 `2026.1.10` 起，OpenClaw 也會抑制**草稿/輸入中串流**，當部分區塊以 `NO_REPLY` 開頭時，避免靜默操作在回合中途洩漏部分輸出。

---

## 預壓縮「記憶刷新」（已實作）

目標：在自動壓縮發生前，執行一個靜默的代理回合，將持久狀態寫入磁碟（例如代理工作區中的 `memory/YYYY-MM-DD.md`），避免壓縮抹除關鍵上下文。

OpenClaw 採用**預閾值刷新**方式：

1. 監控會話上下文使用量。
2. 當超過「軟閾值」（低於 Pi 的壓縮閾值）時，執行一個靜默的「立即寫入記憶」指令給代理。
3. 使用 `NO_REPLY`，讓使用者完全看不到。

設定 (`agents.defaults.compaction.memoryFlush`)：

- `enabled`（預設值：`true`）
- `softThresholdTokens`（預設值：`4000`）
- `prompt`（刷新回合的使用者訊息）
- `systemPrompt`（附加於刷新回合的額外系統提示）

備註：

- 預設提示/系統提示包含一個 `NO_REPLY` 提示，用於抑制輸出。
- flush 在每個壓縮週期執行一次（在 `sessions.json` 中追蹤）。
- flush 僅在嵌入式 Pi 會話中執行（CLI 後端會跳過）。
- 當會話工作區為唯讀時，flush 會被跳過（`workspaceAccess: "ro"` 或 `"none"`）。
- 請參考 [Memory](/concepts/memory) 了解工作區檔案佈局及寫入模式。

Pi 也在擴充 API 中暴露了一個 `session_before_compact` 鉤子，但 OpenClaw 的 flush 邏輯目前仍在 Gateway 端執行。

---

## 疑難排解清單

- 會話金鑰錯誤？請從 [/concepts/session](/concepts/session) 開始，並確認 `sessionKey` 是否在 `/status` 中。
- Store 與 transcript 不匹配？請確認 Gateway 主機與 `openclaw status` 中的 store 路徑。
- 壓縮過度頻繁？請檢查：
  - 模型上下文視窗（過小）
  - 壓縮設定（`reserveTokens` 設定過高，可能導致模型視窗提前壓縮）
  - 工具結果膨脹：啟用或調整會話修剪
- 無聲回合外洩？請確認回覆以 `NO_REPLY`（精確 token）開頭，且您使用的版本包含串流抑制修正。
