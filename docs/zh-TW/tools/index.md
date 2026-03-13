---
summary: >-
  Agent tool surface for OpenClaw (browser, canvas, nodes, message, cron)
  replacing legacy `openclaw-*` skills
read_when:
  - Adding or modifying agent tools
  - Retiring or changing `openclaw-*` skills
title: Tools
---

# 工具 (OpenClaw)

OpenClaw 提供瀏覽器、畫布、節點與排程的**一級代理工具**。  
這些取代了舊有的 `openclaw-*` 技能：工具皆有型別，無需 shell 指令，代理應直接依賴這些工具。

## 停用工具

你可以透過 `tools.allow` / `tools.deny` 在 `openclaw.json` 中全域允許或拒絕工具（拒絕優先）。  
這會阻止不允許的工具被傳送到模型提供者。

```json5
{
  tools: { deny: ["browser"] },
}
```

注意事項：

- 匹配不區分大小寫。
- 支援 `*` 通配符（`"*"` 代表所有工具）。
- 若 `tools.allow` 僅參考未知或未載入的外掛工具名稱，OpenClaw 會記錄警告並忽略允許清單，確保核心工具仍可使用。

## 工具設定檔（基礎允許清單）

`tools.profile` 設定 **基礎工具允許清單**，優先於 `tools.allow` / `tools.deny`。  
每個代理可覆寫：`agents.list[].tools.profile`。

設定檔：

- `minimal`：僅 `session_status`
- `coding`：`group:fs`、`group:runtime`、`group:sessions`、`group:memory`、`image`
- `messaging`：`group:messaging`、`sessions_list`、`sessions_history`、`sessions_send`、`session_status`
- `full`：無限制（等同未設定）

範例（預設僅限訊息功能，並允許 Slack + Discord 工具）：

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

範例（程式碼設定檔，但全面拒絕 exec/process）：

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Example (global coding profile, messaging-only support agent):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## 供應商特定工具政策

使用 `tools.byProvider` 來**進一步限制**特定供應商的工具
（或單一 `provider/model`），而不改變您的全域預設設定。
每個代理的覆寫：`agents.list[].tools.byProvider`。

此設定會在基礎工具設定檔之後、允許/拒絕清單之前套用，
因此只能縮小工具集。
供應商鍵接受 `provider`（例如 `google-antigravity`）或
`provider/model`（例如 `openai/gpt-5.2`）。

範例（保留全域程式碼設定檔，但對 Google Antigravity 使用最少工具）：

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

範例（針對不穩定端點的供應商/模型特定允許清單）：

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

範例（單一供應商的代理特定覆寫）：

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## 工具群組（簡寫）

工具政策（全域、代理、沙盒）支援 `group:*` 條目，可展開為多個工具。
在 `tools.allow` / `tools.deny` 中使用這些。

可用群組：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:web`：`web_search`、`web_fetch`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有內建 OpenClaw 工具（不包含供應商外掛）

Example (allow only file tools + browser):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 外掛程式 + 工具

外掛程式可以註冊 **額外工具**（以及 CLI 指令），超出核心工具集。
請參考 [外掛程式](/tools/plugin) 了解安裝與設定，及 [技能](/tools/skills) 了解如何將工具使用指引注入提示中。有些外掛會同時提供自己的技能與工具（例如語音通話外掛）。

可選的外掛工具：

- [Lobster](/tools/lobster)：具型別的工作流程執行環境，支援可恢復的審核（需在 gateway 主機安裝 Lobster CLI）。
- [LLM Task](/tools/llm-task)：僅支援 JSON 的 LLM 步驟，用於結構化工作流程輸出（可選擇啟用 schema 驗證）。
- [Diffs](/tools/diffs)：唯讀差異檢視器，並可將前後文字或統一補丁渲染成 PNG 或 PDF 檔案。

## 工具清單

### `apply_patch`

可跨一個或多個檔案套用結構化補丁。適用於多段修改。
實驗性功能：透過 `tools.exec.applyPatch.enabled` 啟用（僅限 OpenAI 模型）。
`tools.exec.applyPatch.workspaceOnly` 預設為 `true`（限制於工作區內）。只有當你有意讓 `apply_patch` 在工作區目錄外寫入/刪除時，才將其設為 `false`。

### `exec`

在工作區執行 shell 指令。

核心參數：

- `command`（必填）
- `yieldMs`（逾時後自動背景執行，預設 10000）
- `background`（立即背景執行）
- `timeout`（秒數；超過則終止程序，預設 1800）
- `elevated`（布林值；若啟用/允許提升權限模式則在主機執行；僅在代理被沙盒限制時改變行為）
- `host`（`sandbox | gateway | node`）
- `security`（`deny | allowlist | full`）
- `ask`（`off | on-miss | always`）
- `node`（`host=node` 的節點 ID/名稱）
- 需要真實 TTY？請設定 `pty: true`。

注意事項：

- 背景執行時會回傳 `status: "running"` 及 `sessionId`。
- 使用 `process` 來輪詢／記錄／寫入／終止／清除背景工作階段。
- 若不允許 `process`，`exec` 將同步執行，並忽略 `yieldMs`／`background`。
- `elevated` 受限於 `tools.elevated` 及任何 `agents.list[].tools.elevated` 覆寫（兩者皆須允許），且是 `host=gateway` + `security=full` 的別名。
- `elevated` 僅在代理被沙盒限制時改變行為（否則無效）。
- `host=node` 可指定 macOS 伴隨應用程式或無頭節點主機（`openclaw node run`）。
- gateway／節點的執行批准與允許清單詳見：[執行批准](/tools/exec-approvals)。

### `process`

管理背景執行會話。

核心操作：

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

注意事項：

- `poll` 在完成時回傳新的輸出與退出狀態。
- `log` 支援基於行的 `offset`/`limit`（省略 `offset` 可取得最後 N 行）。
- `process` 以代理為範圍；無法看到其他代理的會話。

### `loop-detection`（工具呼叫迴圈防護）

OpenClaw 會追蹤近期的工具呼叫歷史，並在偵測到重複且無進展的迴圈時阻擋或警告。
可透過 `tools.loopDetection.enabled: true` 啟用（預設為 `false`）。

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      historySize: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `genericRepeat`：重複相同工具 + 相同參數的呼叫模式。
- `knownPollNoProgress`：重複輪詢類工具且輸出相同。
- `pingPong`：交替出現的 `A/B/A/B` 無進展模式。
- 代理層級覆寫：`agents.list[].tools.loopDetection`。

### `web_search`

使用 Perplexity、Brave、Gemini、Grok 或 Kimi 搜尋網路。

核心參數：

- `query`（必填）
- `count`（1–10；預設值來自 `tools.web.search.maxResults`）

注意事項：

- 需要所選供應商的 API 金鑰（建議使用：`openclaw configure --section web`）。
- 透過 `tools.web.search.enabled` 啟用。
- 回應會快取（預設 15 分鐘）。
- 請參考 [Web 工具](/tools/web) 進行設定。

### `web_fetch`

從 URL 擷取並抽取可讀內容（HTML → markdown/文字）。

核心參數：

- `url`（必填）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截斷過長頁面）

注意事項：

- 透過 `tools.web.fetch.enabled` 啟用。
- `maxChars` 受限於 `tools.web.fetch.maxCharsCap`（預設 50000）。
- 回應會快取（預設 15 分鐘）。
- 對於重度使用 JS 的網站，建議使用瀏覽器工具。
- 請參考 [Web 工具](/tools/web) 進行設定。
- 可選的反機器人備援請參考 [Firecrawl](/tools/firecrawl)。

### `browser`

控制專用的 OpenClaw 管理瀏覽器。

核心操作：

- `status`、`start`、`stop`、`tabs`、`open`、`focus`、`close`
- `snapshot`（aria/ai）
- `screenshot`（回傳圖片區塊 + `MEDIA:<path>`）
- `act`（UI 操作：點擊/輸入/按鍵/懸停/拖曳/選取/填寫/調整大小/等待/評估）
- `navigate`、`console`、`pdf`、`upload`、`dialog`

設定檔管理：

- `profiles` — 列出所有瀏覽器設定檔及狀態
- `create-profile` — 建立新設定檔並自動分配埠口（或使用 `cdpUrl`）
- `delete-profile` — 停止瀏覽器、刪除使用者資料、從設定中移除（僅限本機）
- `reset-profile` — 終止設定檔埠口上的孤兒程序（僅限本機）

通用參數：

- `profile`（選填；預設為 `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（選填；指定特定節點 id/名稱）
  注意事項：
- 需要 `browser.enabled=true`（預設為 `true`；設定 `false` 可停用）。
- 所有操作皆接受選填的 `profile` 參數以支援多實例。
- 當省略 `profile` 時，使用 `browser.defaultProfile`（預設為 "chrome"）。
- 設定檔名稱：僅限小寫英數字與連字號（最多 64 字元）。
- 埠口範圍：18800-18899（最多約 100 個設定檔）。
- 遠端設定檔僅能附加，無法啟動/停止/重置。
- 若有連接可瀏覽器節點，工具可能會自動導向該節點（除非你鎖定 `target`）。
- `snapshot` 在安裝 Playwright 時預設為 `ai`；使用 `aria` 可取得無障礙樹。
- `snapshot` 也支援角色快照選項（`interactive`、`compact`、`depth`、`selector`），會回傳類似 `e12` 的參考。
- `act` 需要 `ref` 來自 `snapshot`（數字型 `12` 來自 AI 快照，或 `e12` 來自角色快照）；罕見 CSS 選擇器需求請使用 `evaluate`。
- 預設避免使用 `act` → `wait`；僅在特殊情況下使用（無可靠 UI 狀態可等待）。
- `upload` 可選擇傳入 `ref`，以在啟動後自動點擊。
- `upload` 也支援 `inputRef`（aria 參考）或 `element`（CSS 選擇器）以直接設定 `<input type="file">`。

### `canvas`

驅動節點 Canvas（present、eval、snapshot、A2UI）。

核心操作：

- `present`、`hide`、`navigate`、`eval`
- `snapshot`（回傳影像區塊 + `MEDIA:<path>`）
- `a2ui_push`、`a2ui_reset`

注意事項：

- 底層使用 gateway `node.invoke`。
- 若未提供 `node`，工具會選擇預設值（單一連線節點或本地 mac 節點）。
- A2UI 僅支援 v0.8（不支援 `createSurface`）；CLI 會拒絕 v0.9 JSONL 並顯示行錯誤。
- 快速測試：`openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`。

### `nodes`

發現並定位配對節點；發送通知；擷取相機／螢幕畫面。

核心操作：

- `status`、`describe`
- `pending`、`approve`、`reject`（配對）
- `notify`（macOS `system.notify`）
- `run`（macOS `system.run`）
- `camera_list`、`camera_snap`、`camera_clip`、`screen_record`
- `location_get`、`notifications_list`、`notifications_action`
- `device_status`、`device_info`、`device_permissions`、`device_health`

注意事項：

- 相機／螢幕指令需節點應用程式在前景執行。
- 影像會回傳影像區塊 + `MEDIA:<path>`。
- 影片會回傳 `FILE:<path>`（mp4 格式）。
- 位置會回傳 JSON 資料（緯度／經度／精確度／時間戳）。
- `run` 參數：`command` argv 陣列；可選 `cwd`、`env`（`KEY=VAL`）、`commandTimeoutMs`、`invokeTimeoutMs`、`needsScreenRecording`。

範例（`run`）：

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

使用已設定的影像模型分析影像。

核心參數：

- `image`（必填路徑或 URL）
- `prompt`（選填；預設為「描述影像內容。」）
- `model`（選填覆寫）
- `maxBytesMb`（選填大小上限）

注意事項：

- 僅在 `agents.defaults.imageModel` 已設定（主要或備用）時可用，或當可從您的預設模型 + 已設定的授權推斷出隱含影像模型時（盡力配對）。
- 直接使用影像模型（獨立於主要聊天模型）。

### `pdf`

分析一個或多個 PDF 文件。

完整行為、限制、設定與範例，請參考 [PDF 工具](/tools/pdf)。

### `message`

跨 Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 發送訊息與頻道操作。

核心操作：

- `send`（文字 + 選填媒體；MS Teams 亦支援 `card` 用於 Adaptive Cards）
- `poll`（WhatsApp/Discord/MS Teams 投票）
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

注意事項：

- `send` 透過 Gateway 路由 WhatsApp；其他頻道則直接連線。
- `poll` WhatsApp 和 MS Teams 使用 Gateway；Discord 投票則直接連線。
- 當訊息工具呼叫綁定至活躍聊天會話時，發送限制於該會話目標，以避免跨上下文洩漏。

### `cron`

管理 Gateway 的排程任務與喚醒。

核心操作：

- `status`、`list`
- `add`、`update`、`remove`、`run`、`runs`
- `wake`（佇列系統事件 + 可選立即心跳）

備註：

- `add` 預期接收完整的排程任務物件（與 `cron.add` RPC 使用相同結構）。
- `update` 使用 `{ jobId, patch }`（為相容性接受 `id`）。

### `gateway`

重新啟動或套用更新至正在執行的 Gateway 程序（原地更新）。

核心操作：

- `restart`（授權並發送 `SIGUSR1` 以進行程序內重啟；`openclaw gateway` 原地重啟）
- `config.schema.lookup`（一次檢視一個設定路徑，無需將完整結構載入提示上下文）
- `config.get`
- `config.apply`（驗證 + 寫入設定 + 重啟 + 喚醒）
- `config.patch`（合併部分更新 + 重啟 + 喚醒）
- `update.run`（執行更新 + 重啟 + 喚醒）

備註：

- `config.schema.lookup` 預期接收目標設定路徑，如 `gateway.auth` 或 `agents.list.*.heartbeat`。
- 路徑中可包含以斜線分隔的外掛 ID，當指向 `plugins.entries.<id>` 時，例如 `plugins.entries.pack/one.config`。
- 使用 `delayMs`（預設為 2000）以避免中斷正在進行的回覆。
- `config.schema` 仍可用於內部控制 UI 流程，且不會透過代理 `gateway` 工具公開。
- `restart` 預設啟用；設定 `commands.restart: false` 可將其停用。

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

列出會話、檢視對話紀錄，或轉送至其他會話。

核心參數：

- `sessions_list`：`kinds?`、`limit?`、`activeMinutes?`、`messageLimit?`（0 = 無）
- `sessions_history`：`sessionKey`（或 `sessionId`）、`limit?`、`includeTools?`
- `sessions_send`：`sessionKey`（或 `sessionId`）、`message`、`timeoutSeconds?`（0 = 送出即忘）
- `sessions_spawn`：`task`、`label?`、`runtime?`、`agentId?`、`model?`、`thinking?`、`cwd?`、`runTimeoutSeconds?`、`thread?`、`mode?`、`cleanup?`、`sandbox?`、`streamTo?`、`attachments?`、`attachAs?`
- `session_status`：`sessionKey?`（預設為當前；接受 `sessionId`）、`model?`（`default` 清除覆寫）

說明：

- `main` 是標準的直接聊天鍵；global/unknown 為隱藏狀態。
- `messageLimit > 0` 會抓取每個會話的最後 N 則訊息（過濾工具訊息）。
- 會話目標由 `tools.sessions.visibility` 控制（預設 `tree`：當前會話 + 衍生子代理會話）。若您為多用戶執行共享代理，建議設定 `tools.sessions.visibility: "self"` 以防止跨會話瀏覽。
- `sessions_send` 在 `timeoutSeconds > 0` 時會等待最終完成。
- 傳送/公告在完成後進行，屬於盡力而為；`status: "ok"` 確認代理執行結束，但不代表公告已送達。
- `sessions_spawn` 支援 `runtime: "subagent" | "acp"`（預設 `subagent`）。有關 ACP 執行時行為，請參考 [ACP Agents](/tools/acp-agents)。
- 對於 ACP 執行時，`streamTo: "parent"` 將初始執行進度摘要以系統事件形式回傳給請求者會話，而非直接子交付。
- `sessions_spawn` 啟動子代理執行並回覆公告給請求者聊天。
  - 支援一次性模式（`mode: "run"`）及持續綁定執行緒模式（`mode: "session"` 搭配 `thread: true`）。
  - 若省略 `thread: true` 和 `mode`，模式預設為 `session`。
  - `mode: "session"` 需要 `thread: true`。
  - 若省略 `runTimeoutSeconds`，OpenClaw 會使用設定的 `agents.defaults.subagents.runTimeoutSeconds`；否則逾時預設為 `0`（無逾時）。
  - Discord 綁定執行緒流程依賴 `session.threadBindings.*` 和 `channels.discord.threadBindings.*`。
  - 回覆格式包含 `Status`、`Result` 及簡潔統計。
  - `Result` 是助理完成文字；若缺少，則以最新 `toolResult` 作為備用。
- 手動完成模式會先直接發送，並在暫時性失敗時使用佇列回退與重試（`status: "ok"` 表示執行結束，不代表公告已送達）。
- `sessions_spawn` 僅支援子代理執行時的內嵌檔案附件（ACP 會拒絕）。每個附件包含 `name`、`content`，以及可選的 `encoding`（`utf8` 或 `base64`）和 `mimeType`。檔案會在子工作區的 `.openclaw/attachments/<uuid>/` 實體化，並附有 `.manifest.json` 的元資料檔。工具會回傳包含 `count`、`totalBytes`、每個檔案的 `sha256` 和 `relDir` 的收據。附件內容會自動從記錄持久化中遮蔽。
  - 可透過 `tools.sessions_spawn.attachments`（`enabled`、`maxTotalBytes`、`maxFiles`、`maxFileBytes`、`retainOnSessionKeep`）設定限制。
  - `attachAs.mountPath` 是未來掛載實作的保留提示。
- `sessions_spawn` 為非阻塞，會立即回傳 `status: "accepted"`。
- ACP `streamTo: "parent"` 回應可能包含 `streamLogPath`（會話範圍的 `*.acp-stream.jsonl`）用於追蹤進度歷史。
- `sessions_send` 執行回覆式 ping-pong（回覆 `REPLY_SKIP` 停止；最大回合數由 `session.agentToAgent.maxPingPongTurns` 控制，範圍 0–5）。
- ping-pong 結束後，目標代理會執行 **公告步驟**；回覆 `ANNOUNCE_SKIP` 可抑制公告。
- 沙盒限制：當當前會話為沙盒且 `agents.defaults.sandbox.sessionToolsVisibility: "spawned"` 時，OpenClaw 將 `tools.sessions.visibility` 限制為 `tree`。

### `agents_list`

列出當前會話可用 `sessions_spawn` 指定的代理 ID。

說明：

- 結果受限於每個代理的允許清單 (`agents.list[].subagents.allowAgents`)。
- 當設定 `["*"]` 時，工具會包含所有已設定代理並標記 `allowAny: true`。

## 參數（通用）

Gateway 支援的工具 (`canvas`、`nodes`、`cron`)：

- `gatewayUrl`（預設 `ws://127.0.0.1:18789`）
- `gatewayToken`（若啟用驗證）
- `timeoutMs`

注意：當設定 `gatewayUrl` 時，需明確包含 `gatewayToken`。工具不會繼承設定或環境憑證作為覆寫，缺少明確憑證會導致錯誤。

瀏覽器工具：

- `profile`（可選；預設 `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（可選；指定特定節點 ID/名稱）
- 疑難排解指南：
  - Linux 啟動/CDP 問題：[瀏覽器疑難排解（Linux）](/tools/browser-linux-troubleshooting)
  - WSL2 Gateway + Windows 遠端 Chrome CDP：[WSL2 + Windows + 遠端 Chrome CDP 疑難排解](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)

## 推薦代理流程

瀏覽器自動化：

1. `browser` → `status` / `start`
2. `snapshot`（ai 或 aria）
3. `act`（點擊/輸入/按鍵）
4. `screenshot` 若需要視覺確認

Canvas 渲染：

1. `canvas` → `present`
2. `a2ui_push`（可選）
3. `snapshot`

節點定位：

1. `nodes` → `status`
2. `describe` 在所選節點上
3. `notify` / `run` / `camera_snap` / `screen_record`

## 安全性

- 避免直接 `system.run`；僅在明確取得使用者同意後，使用 `nodes` → `run`。
- 尊重使用者對相機／螢幕擷取的同意。
- 使用 `status/describe` 以確保在呼叫媒體指令前已取得權限。

## 工具如何呈現給代理程式

工具會透過兩個平行管道暴露：

1. **系統提示文字**：人類可讀的清單與指引。
2. **工具結構**：傳送給模型 API 的結構化函式定義。

這表示代理程式同時能看到「有哪些工具」以及「如何呼叫它們」。如果工具未出現在系統提示或結構中，模型將無法呼叫該工具。
