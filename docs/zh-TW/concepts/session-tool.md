---
summary: >-
  Agent session tools for listing sessions, fetching history, and sending
  cross-session messages
read_when:
  - Adding or modifying session tools
title: Session Tools
---

# 會話工具

目標：打造一組小巧且不易誤用的工具集，讓代理能列出會話、擷取歷史紀錄，並傳送到其他會話。

## 工具名稱

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## 主要金鑰模型

- 主要直接聊天桶始終是字面金鑰 `"main"`（解析為當前代理的主要金鑰）。
- 群組聊天使用 `agent:<agentId>:<channel>:group:<id>` 或 `agent:<agentId>:<channel>:channel:<id>`（傳遞完整金鑰）。
- 定時任務使用 `cron:<job.id>`。
- Hooks 使用 `hook:<uuid>`，除非另有明確設定。
- 節點會話使用 `node-<nodeId>`，除非另有明確設定。

`global` 和 `unknown` 是保留值，永遠不會被列出。如果是 `session.scope = "global"`，我們會將它別名為 `main`，讓所有工具呼叫者永遠看不到 `global`。

## sessions_list

將會話列為一組陣列列。

參數：

- `kinds?: string[]` 過濾條件：可為 `"main" | "group" | "cron" | "hook" | "node" | "other"` 中任一
- `limit?: number` 最大列數（預設：伺服器預設，限制例如 200）
- `activeMinutes?: number` 僅包含 N 分鐘內有更新的會話
- `messageLimit?: number` 0 = 不包含訊息（預設 0）；>0 = 包含最後 N 則訊息

行為：

- `messageLimit > 0` 會擷取每個會話的 `chat.history`，並包含最後 N 則訊息。
- 工具結果會在列表輸出中被過濾；工具訊息請使用 `sessions_history`。
- 在 **沙盒化** 代理會話中執行時，會話工具預設為 **僅限衍生可見**（詳見下方）。

列格式（JSON）：

- `key`：會話金鑰（字串）
- `kind`：`main | group | cron | hook | node | other`
- `channel`：`whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName`（群組顯示標籤，如有）
- `updatedAt`（毫秒）
- `sessionId`
- `model`、`contextTokens`、`totalTokens`
- `thinkingLevel`、`verboseLevel`、`systemSent`、`abortedLastRun`
- `sendPolicy`（若有設定會話覆寫）
- `lastChannel`、`lastTo`
- `deliveryContext`（可用時為標準化的 `{ channel, to, accountId }`）
- `transcriptPath`（根據儲存目錄 + sessionId 推測的路徑，盡力而為）
- `messages?`（僅當 `messageLimit > 0` 時）

## sessions_history

取得單一會話的對話紀錄。

參數：

- `sessionKey`（必填；接受會話金鑰或來自 `sessions_list` 的 `sessionId`）
- `limit?: number` 最大訊息數（由伺服器限制）
- `includeTools?: boolean`（預設為 false）

行為：

- `includeTools=false` 過濾 `role: "toolResult"` 訊息。
- 回傳原始對話紀錄格式的訊息陣列。
- 當提供 `sessionId` 時，OpenClaw 會將其解析為對應的會話金鑰（缺少 ID 時會報錯）。

## sessions_send

將訊息發送到另一個會話。

參數：

- `sessionKey`（必填；接受會話金鑰或來自 `sessions_list` 的 `sessionId`）
- `message`（必填）
- `timeoutSeconds?: number`（預設大於 0；0 表示發送後不等待回應）

行為：

- `timeoutSeconds = 0`：將訊息排入佇列並回傳 `{ runId, status: "accepted" }`。
- `timeoutSeconds > 0`：最多等待 N 秒完成，然後回傳 `{ runId, status: "ok", reply }`。
- 若等待逾時：回傳 `{ runId, status: "timeout", error }`。執行繼續；稍後可呼叫 `sessions_history`。
- 若執行失敗：回傳 `{ runId, status: "error", error }`。
- 主要執行完成後會進行公告傳送，為盡力而為；`status: "ok"` 不保證公告已送達。
- 透過閘道 `agent.wait`（伺服器端）等待，避免重新連線時中斷等待。
- 主要執行時會注入代理人間的訊息上下文。
- 跨會話訊息會以 `message.provenance.kind = "inter_session"` 持久化，讓對話紀錄讀取者能區分路由的代理人指令與外部使用者輸入。
- 主要執行完成後，OpenClaw 會執行 **回覆迴圈**：
  - 從第二輪開始，雙方代理人交替回覆。
  - 回覆精確為 `REPLY_SKIP` 可停止此乒乓回覆。
  - 最大回合數為 `session.agentToAgent.maxPingPongTurns`（0–5，預設為 5）。
- 迴圈結束後，OpenClaw 執行 **代理人間公告步驟**（僅限目標代理人）：
  - 回覆精確為 `ANNOUNCE_SKIP` 則保持靜默。
  - 其他回覆會送至目標頻道。
  - 公告步驟包含原始請求 + 第一輪回覆 + 最新乒乓回覆。

## Channel Field

- 群組時，`channel` 是會話紀錄中記錄的頻道。
- 直接聊天時，`channel` 由 `lastChannel` 映射。
- 定時任務／Webhook／節點時，`channel` 是 `internal`。
- 若缺少，`channel` 為 `unknown`。

## Security / Send Policy

依頻道/聊天類型的政策阻擋（非依會話 ID）。

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

執行時覆寫（每會話條目）：

- `sendPolicy: "allow" | "deny"`（未設定 = 繼承設定）
- 可透過 `sessions.patch` 或僅限擁有者的 `/send on|off|inherit`（獨立訊息）設定。

執行點：

- `chat.send` / `agent`（閘道）
- 自動回覆傳遞邏輯

## sessions_spawn

在隔離的會話中啟動子代理執行，並將結果回報給請求者的聊天頻道。

參數：

- `task`（必填）
- `label?`（選填；用於日誌/UI）
- `agentId?`（選填；若允許，則在另一代理 ID 下啟動）
- `model?`（選填；覆寫子代理模型；無效值會報錯）
- `thinking?`（選填；覆寫子代理執行的思考層級）
- `runTimeoutSeconds?`（設定時預設為 `agents.defaults.subagents.runTimeoutSeconds`，否則為 `0`；設定後，子代理執行會在 N 秒後中止）
- `thread?`（預設為 false；當頻道/外掛支援時，請求綁定執行緒路由）
- `mode?`（`run|session`；預設為 `run`，但當 `thread=true` 時預設為 `session`；`mode="session"` 需要 `thread=true`）
- `cleanup?`（`delete|keep`，預設 `keep`）
- `sandbox?`（`inherit|require`，預設 `inherit`；`require` 拒絕啟動，除非目標子執行環境為沙盒）
- `attachments?`（選填的內嵌檔案陣列；僅限子代理執行環境，ACP 會拒絕）。每筆條目為 `{ name, content, encoding?: "utf8" | "base64", mimeType? }`。檔案會被實體化到子工作區的 `.openclaw/attachments/<uuid>/`。回傳包含每個檔案 sha256 的收據。
- `attachAs?`（選填；`{ mountPath? }` 提示保留給未來的掛載實作）

允許清單：

- `agents.list[].subagents.allowAgents`：允許透過 `agentId` 的代理 ID 清單（`["*"]` 允許任意）。預設：僅限請求者代理。
- 沙盒繼承防護：若請求者會話為沙盒，`sessions_spawn` 會拒絕執行非沙盒的目標。

發現：

- 使用 `agents_list` 來發現哪些代理 ID 被允許用於 `sessions_spawn`。

行為：

- 啟動一個新的 `agent:<agentId>:subagent:<uuid>` 會話，使用 `deliver: false`。
- 子代理預設使用完整工具集 **但不包含會話工具**（可透過 `tools.subagents.tools` 設定）。
- 子代理不允許呼叫 `sessions_spawn`（禁止子代理 → 子代理的產生）。
- 永遠非阻塞：立即回傳 `{ status: "accepted", runId, childSessionKey }`。
- 使用 `thread=true` 時，頻道插件可以綁定傳遞/路由到特定執行緒目標（Discord 支援由 `session.threadBindings.*` 和 `channels.discord.threadBindings.*` 控制）。
- 完成後，OpenClaw 執行子代理 **公告步驟** 並將結果發佈到請求者的聊天頻道。
  - 若助理最終回覆為空，則會將子代理歷史中最新的 `toolResult` 以 `Result` 形式包含進去。
- 公告步驟期間，回覆必須完全是 `ANNOUNCE_SKIP` 以保持靜默。
- 公告回覆會標準化為 `Status`/`Result`/`Notes`；`Status` 來自執行時結果（非模型文字）。
- 子代理會話在 `agents.defaults.subagents.archiveAfterMinutes` 後自動封存（預設：60）。
- 公告回覆包含統計行（執行時間、token 數、sessionKey/sessionId、文字記錄路徑及可選成本）。

## 沙盒會話可見性

會話工具可設定範圍以減少跨會話存取。

預設行為：

- `tools.sessions.visibility` 預設為 `tree`（當前會話 + 所產生的子代理會話）。
- 對於沙盒會話，`agents.defaults.sandbox.sessionToolsVisibility` 可強制限制可見性。

設定：

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      // default: "tree"
      visibility: "tree",
    },
  },
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```

說明：

- `self`：僅限當前會話金鑰。
- `tree`：當前會話 + 由當前會話產生的會話。
- `agent`：屬於當前代理 ID 的任何會話。
- `all`：任何會話（跨代理存取仍需 `tools.agentToAgent`）。
- 當會話被沙盒化且 `sessionToolsVisibility="spawned"` 時，OpenClaw 即使設定了 `tools.sessions.visibility="all"`，也會將可見性限制為 `tree`。
