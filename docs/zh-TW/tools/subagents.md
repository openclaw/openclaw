---
summary: "子代理程式：產生隔離的代理程式執行，並將結果回報給請求者聊天"
read_when:
  - 你需要透過代理程式進行背景／平行工作
  - 你正在變更 sessions_spawn 或 子代理程式 工具政策
title: "子代理程式"
---

# Sub-agents

50. 子代理是從既有代理執行中衍生的背景代理執行。 They run in their own session (`agent:<agentId>:subagent:<uuid>`) and, when finished, **announce** their result back to the requester chat channel.

## 斜線指令

使用 `/subagents` 來檢視或控制**目前工作階段**的子代理程式執行：

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` shows run metadata (status, timestamps, session id, transcript path, cleanup).

主要目標：

- 在不阻塞主要執行的情況下，將「研究／長時間任務／慢速工具」的工作平行化。
- 預設保持子代理程式的隔離（工作階段分離＋可選的沙箱隔離）。
- Keep the tool surface hard to misuse: sub-agents do **not** get session tools by default.
- Avoid nested fan-out: sub-agents cannot spawn sub-agents.

Cost note: each sub-agent has its **own** context and token usage. For heavy or repetitive
tasks, set a cheaper model for sub-agents and keep your main agent on a higher-quality model.
You can configure this via `agents.defaults.subagents.model` or per-agent overrides.

## 工具

使用 `sessions_spawn`：

- 啟動一個子代理程式執行（`deliver: false`，全域佇列通道：`subagent`）
- Then runs an announce step and posts the announce reply to the requester chat channel
- 預設模型：繼承呼叫者，除非你設定 `agents.defaults.subagents.model`（或逐代理程式的 `agents.list[].subagents.model`）；明確指定的 `sessions_spawn.model` 仍然優先。
- 預設思考層級：繼承呼叫者，除非你設定 `agents.defaults.subagents.thinking`（或逐代理程式的 `agents.list[].subagents.thinking`）；明確指定的 `sessions_spawn.thinking` 仍然優先。

工具參數：

- `task`（必填）
- `label?`（選填）
- `agentId?`（選填；若允許，則在另一個代理程式 id 底下產生）
- `model?`（選填；覆寫子代理程式模型；無效值會被略過，子代理程式將以預設模型執行，並在工具結果中顯示警告）
- `thinking?`（選填；覆寫子代理程式執行的思考層級）
- `runTimeoutSeconds?`（預設 `0`；設定後，子代理程式執行會在 N 秒後中止）
- `cleanup?`（`delete|keep`，預設 `keep`）

允許清單：

- `agents.list[].subagents.allowAgents`：可透過 `agentId` 指定的代理程式 id 清單（`["*"]` 以允許任何）。預設：僅請求者代理程式。 Default: only the requester agent.

探索：

- 使用 `agents_list` 查看目前允許用於 `sessions_spawn` 的代理程式 id。

自動封存：

- 子代理程式工作階段會在 `agents.defaults.subagents.archiveAfterMinutes` 後自動封存（預設：60）。
- 封存會使用 `sessions.delete`，並將逐字稿重新命名為 `*.deleted.<timestamp>`（同一資料夾）。
- `cleanup: "delete"` 會在公告後立即封存（仍會透過重新命名保留逐字稿）。
- Auto-archive is best-effort; pending timers are lost if the gateway restarts.
- `runTimeoutSeconds` **不會**自動封存；它只會停止執行。工作階段會保留直到自動封存。 工作階段會一直存在直到自動封存。

## Authentication

Sub-agent auth is resolved by **agent id**, not by session type:

- 子代理程式的工作階段金鑰為 `agent:<agentId>:subagent:<uuid>`。
- The auth store is loaded from that agent’s `agentDir`.
- The main agent’s auth profiles are merged in as a **fallback**; agent profiles override main profiles on conflicts.

Note: the merge is additive, so main profiles are always available as fallbacks. Fully isolated auth per agent is not supported yet.

## 公告

Sub-agents report back via an announce step:

- The announce step runs inside the sub-agent session (not the requester session).
- If the sub-agent replies exactly `ANNOUNCE_SKIP`, nothing is posted.
- 否則，公告回覆會透過後續的 `agent` 呼叫（`deliver=true`）張貼到請求者聊天頻道。
- 在可用時，公告回覆會保留執行緒／主題路由（Slack 執行緒、Telegram 主題、Matrix 執行緒）。
- 公告訊息會正規化為穩定的範本：
  - `Status:` 依據執行結果推導（`success`、`error`、`timeout`，或 `unknown`）。
  - `Result:` 為公告步驟的摘要內容（若缺失則為 `(not available)`）。
  - `Notes:` 為錯誤細節與其他有用的脈絡。
- `Status` 並非從模型輸出推斷；它來自執行期的結果訊號。

公告承載內容在結尾會包含一行統計資訊（即使被包裝）：

- 執行時間（例如：`runtime 5m12s`）
- Token usage (input/output/total)
- 在設定模型定價時的估計成本（`models.providers.*.models[].cost`）
- `sessionKey`、`sessionId`，以及逐字稿路徑（因此主要代理程式可透過 `sessions_history` 取得歷史紀錄，或在磁碟上檢視檔案）

## 工具政策（子代理程式工具）

預設情況下，子代理程式會取得**除工作階段工具以外的所有工具**：

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Override via config:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 併發

子代理程式使用專用的行程內佇列通道：

- 通道名稱：`subagent`
- 併發數：`agents.defaults.subagents.maxConcurrent`（預設 `8`）

## 停止

- 在請求者聊天中送出 `/stop` 會中止請求者工作階段，並停止由其產生的任何活動中子代理程式執行。

## 限制

- Sub-agent announce is **best-effort**. If the gateway restarts, pending “announce back” work is lost.
- Sub-agents still share the same gateway process resources; treat `maxConcurrent` as a safety valve.
- `sessions_spawn` 一律為非阻塞：它會立即回傳 `{ status: "accepted", runId, childSessionKey }`。
- 子代理程式脈絡只會注入 `AGENTS.md` ＋ `TOOLS.md`（不包含 `SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`，或 `BOOTSTRAP.md`）。
