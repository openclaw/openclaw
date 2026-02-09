---
summary: "聊天的工作階段管理規則、鍵值與持久化"
read_when:
  - 修改工作階段處理或儲存時
title: "工作階段管理"
---

# 工作階段管理

OpenClaw 將 **每個代理的一個直接聊天工作階段** 視為主要。 直接聊天會摺疊為 `agent:<agentId>:<mainKey>`（預設 `main`），而群組／頻道聊天則各自擁有鍵值。 `session.mainKey` 會被遵守。

使用 `session.dmScope` 來控制\*\*私訊（DM）\*\*如何分組：

- `main`（預設）：所有私訊共用主要工作階段以維持連續性。
- `per-peer`：依寄件者 id 跨頻道隔離。
- `per-channel-peer`：依頻道 + 寄件者隔離（建議用於多使用者收件匣）。
- `per-account-channel-peer`：依帳號 + 頻道 + 發送者隔離（建議用於多帳號收件匣）。
  `per-account-channel-peer`：依帳號 + 頻道 + 寄件者隔離（建議用於多帳號收件匣）。
  使用 `session.identityLinks` 將帶有提供者前綴的對端 id 對映到標準化身分，讓同一個人在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 時，能跨頻道共用同一個私訊工作階段。

## 安全私訊模式（建議用於多使用者設定）

> **安全警告：** 若你的代理可接收來自 **多位使用者** 的私訊，強烈建議啟用安全私訊模式。 若未啟用，所有使用者將共用相同的對話內容，可能在使用者之間洩漏私人資訊。

**預設設定的問題範例：**

- Alice（`<SENDER_A>`）就私人主題（例如醫療預約）向你的代理程式傳送訊息
- Bob（`<SENDER_B>`）向你的代理程式詢問「我們剛剛在聊什麼？」
- 因為兩則私訊共用同一個工作階段，模型可能會用 Alice 先前的脈絡回覆 Bob。

**解法：** 設定 `dmScope`，讓每位使用者各自隔離工作階段：

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**何時啟用：**

- 你已對多位發送者給予配對核准
- 你使用包含多個項目的私訊允許清單
- 你設定了 `dmPolicy: "open"`
- 有多個電話號碼或帳號可向你的代理程式傳訊

注意事項：

- 預設為 `dmScope: "main"` 以維持連續性（所有私訊共用主要工作階段）。此設定適合單一使用者。 這對單一使用者的設定是可以的。
- 同一頻道的多帳號收件匣，建議使用 `per-account-channel-peer`。
- 若同一個人透過多個頻道聯絡你，使用 `session.identityLinks` 可將其私訊工作階段折疊為單一標準身分。
- 你可以用 `openclaw security audit` 驗證私訊設定（參見 [security](/cli/security)）。

## Gateway 是事實來源

所有工作階段狀態皆 **由閘道**（「主控」OpenClaw）**擁有**。 UI 用戶端（macOS 應用程式、WebChat 等） 必須向閘道查詢工作階段清單與權杖計數，而非讀取本機檔案。

- 在**遠端模式**下，你關心的工作階段儲存位於遠端的閘道器主機，而非你的 Mac。
- UI 中顯示的權杖計數來自閘道的儲存欄位（`inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`）。 用戶端不會解析 JSONL 逐字稿來「修正」總計。

## 狀態所在位置

- 在**閘道器主機**上：
  - 儲存檔案：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（每個代理程式）。
- 逐字稿：`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`（Telegram 主題工作階段使用 `.../<SessionId>-topic-<threadId>.jsonl`）。
- 儲存內容是一個對映表 `sessionKey -> { sessionId, updatedAt, ...  }`. }\`。刪除項目是安全的；需要時會重新建立。
- 群組項目可能包含 `displayName`、`channel`、`subject`、`room` 與 `space`，以在 UI 中標示工作階段。
- 工作階段項目包含 `origin` 中繼資料（標籤 + 路由提示），以便 UI 說明工作階段的來源。
- OpenClaw **不會**讀取舊版 Pi/Tau 的工作階段資料夾。

## Session pruning

OpenClaw trims **old tool results** from the in-memory context right before LLM calls by default.
This does **not** rewrite JSONL history. See [/concepts/session-pruning](/concepts/session-pruning).

## Pre-compaction memory flush

When a session nears auto-compaction, OpenClaw can run a **silent memory flush**
turn that reminds the model to write durable notes to disk. This only runs when
the workspace is writable. See [Memory](/concepts/memory) and
[Compaction](/concepts/compaction).

## Mapping transports → session keys

- 直接聊天遵循 `session.dmScope`（預設 `main`）。
  - `main`：`agent:<agentId>:<mainKey>`（跨裝置／頻道的連續性）。
    - 多個電話號碼與頻道可對映到同一個代理程式主要金鑰；它們作為通往同一對話的傳輸入口。
  - `per-peer`：`agent:<agentId>:dm:<peerId>`。
  - `per-channel-peer`：`agent:<agentId>:<channel>:dm:<peerId>`。
  - `per-account-channel-peer`：`agent:<agentId>:<channel>:<accountId>:dm:<peerId>`（accountId 預設為 `default`）。
  - 若 `session.identityLinks` 符合帶有提供者前綴的對端 id（例如 `telegram:123`），則以標準金鑰取代 `<peerId>`，讓同一個人能跨頻道共用工作階段。
- 群組聊天會隔離狀態：`agent:<agentId>:<channel>:group:<id>`（房間／頻道使用 `agent:<agentId>:<channel>:channel:<id>`）。
  - Telegram 論壇主題會將 `:topic:<threadId>` 附加到群組 id 以進行隔離。
  - 舊版 `group:<id>` 金鑰仍被識別以利遷移。
- 進站脈絡仍可能使用 `group:<id>`；頻道會由 `Provider` 推斷，並正規化為標準的 `agent:<agentId>:<channel>:group:<id>` 形式。
- 其他來源：
  - 排程工作：`cron:<job.id>`
  - Webhooks：`hook:<uuid>`（除非由 hook 明確設定）
  - 節點執行：`node-<nodeId>`

## 生命週期

- Reset policy: sessions are reused until they expire, and expiry is evaluated on the next inbound message.
- Daily reset: defaults to **4:00 AM local time on the gateway host**. A session is stale once its last update is earlier than the most recent daily reset time.
- Idle reset (optional): `idleMinutes` adds a sliding idle window. When both daily and idle resets are configured, **whichever expires first** forces a new session.
- 舊版僅閒置：若你只設定 `session.idleMinutes`，而未設定任何 `session.reset`/`resetByType`，OpenClaw 會為了相容性而維持僅閒置模式。
- 依類型覆寫（選用）：`resetByType` 可覆寫 `dm`、`group` 與 `thread` 工作階段的政策（thread = Slack/Discord 討論串、Telegram 主題、Matrix 討論串，當連接器提供時）。
- 依頻道覆寫（選用）：`resetByChannel` 會覆寫某頻道的重設政策（套用於該頻道的所有工作階段類型，且優先於 `reset`/`resetByType`）。
- Reset triggers: exact `/new` or `/reset` (plus any extras in `resetTriggers`) start a fresh session id and pass the remainder of the message through. `/new <model>` accepts a model alias, `provider/model`, or provider name (fuzzy match) to set the new session model. If `/new` or `/reset` is sent alone, OpenClaw runs a short “hello” greeting turn to confirm the reset.
- 手動重設：從儲存中刪除特定金鑰，或移除 JSONL 逐字稿；下一則訊息會重新建立。
- 隔離的排程工作每次執行都會產生全新的 `sessionId`（不會重用閒置）。

## 傳送政策（選用）

Block delivery for specific session types without listing individual ids.

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

執行期覆寫（僅擁有者）：

- `/send on` → 允許此工作階段
- `/send off` → 拒絕此工作階段
- `/send inherit` → 清除覆寫並使用設定規則
  請以獨立訊息傳送，確保能被註冊。

## 設定（選用重新命名範例）

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
      dm: { mode: "idle", idleMinutes: 240 },
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

- `openclaw status` — 顯示儲存路徑與近期工作階段。
- `openclaw sessions --json` — 傾印所有項目（可用 `--active <minutes>` 篩選）。
- `openclaw gateway call sessions.list --params '{}'` — 從執行中的 Gateway 取得工作階段（遠端 Gateway 存取請用 `--url`/`--token`）。
- 在聊天中以獨立訊息傳送 `/status`，即可查看代理程式是否可連線、使用了多少工作階段脈絡、目前的思考／詳細輸出切換狀態，以及你的 WhatsApp Web 憑證上次重新整理時間（有助於判斷是否需要重新連結）。
- 傳送 `/context list` 或 `/context detail` 以查看系統提示與注入的工作區檔案（以及最大的脈絡貢獻者）。
- 以獨立訊息傳送 `/stop` 可中止目前的執行、清除該工作階段佇列中的後續動作，並停止由其產生的任何子代理程式執行（回覆會包含已停止的數量）。
- 以獨立訊息傳送 `/compact`（可選指示）以摘要較舊的脈絡並釋放視窗空間。請參見 [/concepts/compaction](/concepts/compaction)。 See [/concepts/compaction](/concepts/compaction).
- 可直接開啟 JSONL 逐字稿以檢視完整回合。

## 小技巧

- Keep the primary key dedicated to 1:1 traffic; let groups keep their own keys.
- 自動化清理時，刪除個別金鑰而非整個儲存，以保留其他脈絡。

## Session origin metadata

Each session entry records where it came from (best-effort) in `origin`:

- `label`：人類可讀標籤（由對話標籤 + 群組主題／頻道解析）
- `provider`：正規化的頻道 id（含擴充）
- `from`/`to`：來自進站封裝的原始路由 id
- `accountId`：提供者帳號 id（多帳號時）
- `threadId`: thread/topic id when the channel supports it
  The origin fields are populated for direct messages, channels, and groups. If a
  connector only updates delivery routing (for example, to keep a DM main session
  fresh), it should still provide inbound context so the session keeps its
  explainer metadata. Extensions can do this by sending `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace`, and `SenderName` in the inbound
  context and calling `recordSessionMetaFromInbound` (or passing the same context
  to `updateLastRoute`).
