---
summary: "OpenClaw 的代理程式工具介面（browser、canvas、nodes、message、cron），用以取代舊版的 `openclaw-*` Skills"
read_when:
  - 新增或修改代理程式工具時
  - 退役或變更 `openclaw-*` Skills 時
title: "工具"
x-i18n:
  source_path: tools/index.md
  source_hash: 84d3788b0f5df3d5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:22Z
---

# 工具（OpenClaw）

OpenClaw 提供 **一級代理程式工具**，涵蓋 browser、canvas、nodes 與 cron。
這些工具取代舊版的 `openclaw-*` Skills：工具具備型別定義、不需要 shelling，
且代理程式應直接依賴它們。

## 停用工具

你可以在 `openclaw.json` 中，透過 `tools.allow` / `tools.deny` 全域允許或拒絕工具
（拒絕優先）。這會防止不被允許的工具送往模型提供者。

```json5
{
  tools: { deny: ["browser"] },
}
```

注意事項：

- 比對不區分大小寫。
- 支援 `*` 萬用字元（`"*"` 代表所有工具）。
- 若 `tools.allow` 僅參照未知或未載入的外掛工具名稱，OpenClaw 會記錄警告並忽略允許清單，以確保核心工具仍可使用。

## 工具設定檔（基礎允許清單）

`tools.profile` 會在 `tools.allow`/`tools.deny` 之前設定 **基礎工具允許清單**。
每個代理程式可覆寫：`agents.list[].tools.profile`。

設定檔：

- `minimal`：僅 `session_status`
- `coding`：`group:fs`、`group:runtime`、`group:sessions`、`group:memory`、`image`
- `messaging`：`group:messaging`、`sessions_list`、`sessions_history`、`sessions_send`、`session_status`
- `full`：不限制（與未設定相同）

範例（預設僅訊息傳遞，另允許 Slack + Discord 工具）：

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

範例（程式開發設定檔，但在所有地方拒絕 exec/process）：

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

範例（全域程式開發設定檔，僅訊息傳遞的支援代理程式）：

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

## 提供者專屬的工具政策

使用 `tools.byProvider` 可針對特定提供者
（或單一 `provider/model`）**進一步限制** 工具，而不影響你的全域預設值。
每個代理程式可覆寫：`agents.list[].tools.byProvider`。

此設定會在基礎工具設定檔 **之後**、允許/拒絕清單 **之前** 套用，
因此只能縮小工具集合。
提供者鍵值可接受 `provider`（例如 `google-antigravity`）或
`provider/model`（例如 `openai/gpt-5.2`）。

範例（保留全域程式開發設定檔，但為 Google Antigravity 使用最小工具集）：

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

範例（針對不穩定端點的提供者/模型專屬允許清單）：

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

範例（單一提供者的代理程式專屬覆寫）：

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

## 工具群組（速記）

工具政策（全域、代理程式、沙箱）支援 `group:*` 項目，可展開為多個工具。
可在 `tools.allow` / `tools.deny` 中使用。

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
- `group:openclaw`：所有內建的 OpenClaw 工具（不包含提供者外掛）

範例（僅允許檔案工具 + browser）：

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 外掛 + 工具

外掛可在核心工具之外註冊 **額外工具**（以及 CLI 指令）。
請參閱 [Plugins](/tools/plugin) 了解安裝與設定，並參閱 [Skills](/tools/skills) 了解
如何將工具使用指引注入提示。部分外掛會隨工具一併提供自己的 Skills
（例如語音通話外掛）。

可選外掛工具：

- [Lobster](/tools/lobster)：具備可恢復核准的型別化工作流程執行階段（需要在閘道器主機上安裝 Lobster CLI）。
- [LLM Task](/tools/llm-task)：僅 JSON 的 LLM 步驟，用於結構化工作流程輸出（可選的結構驗證）。

## 工具清單

### `apply_patch`

在一或多個檔案上套用結構化修補。適用於多段（multi-hunk）編輯。
實驗性功能：透過 `tools.exec.applyPatch.enabled` 啟用（僅 OpenAI 模型）。

### `exec`

在工作區中執行 shell 指令。

核心參數：

- `command`（必填）
- `yieldMs`（逾時後自動背景執行，預設 10000）
- `background`（立即背景執行）
- `timeout`（秒；超過即終止程序，預設 1800）
- `elevated`（bool；若啟用/允許提升模式，則在主機上執行；僅在代理程式處於沙箱時才會改變行為）
- `host`（`sandbox | gateway | node`）
- `security`（`deny | allowlist | full`）
- `ask`（`off | on-miss | always`）
- `node`（`host=node` 的節點 id/名稱）
- 需要真正的 TTY？設定 `pty: true`。

注意事項：

- 背景執行時會回傳 `status: "running"` 與 `sessionId`。
- 使用 `process` 來輪詢/記錄/寫入/終止/清除背景工作階段。
- 若 `process` 被拒絕，`exec` 會同步執行並忽略 `yieldMs`/`background`。
- `elevated` 受 `tools.elevated` 與任何 `agents.list[].tools.elevated` 覆寫所控管（兩者皆須允許），且是 `host=gateway` + `security=full` 的別名。
- `elevated` 僅在代理程式處於沙箱時才會改變行為（否則為 no-op）。
- `host=node` 可指向 macOS 配套應用程式或無介面的節點主機（`openclaw node run`）。
- 閘道器/節點核准與允許清單：[Exec approvals](/tools/exec-approvals)。

### `process`

管理背景 exec 工作階段。

核心動作：

- `list`、`poll`、`log`、`write`、`kill`、`clear`、`remove`

注意事項：

- `poll` 在完成時會回傳新輸出與結束狀態。
- `log` 支援以行為基礎的 `offset`/`limit`（省略 `offset` 以擷取最後 N 行）。
- `process` 以代理程式為作用域；其他代理程式的工作階段不可見。

### `web_search`

使用 Brave Search API 搜尋網頁。

核心參數：

- `query`（必填）
- `count`（1–10；預設值來自 `tools.web.search.maxResults`）

注意事項：

- 需要 Brave API 金鑰（建議：`openclaw configure --section web`，或設定 `BRAVE_API_KEY`）。
- 透過 `tools.web.search.enabled` 啟用。
- 回應會被快取（預設 15 分鐘）。
- 設定方式請見 [Web tools](/tools/web)。

### `web_fetch`

從 URL 擷取並抽取可讀內容（HTML → markdown/text）。

核心參數：

- `url`（必填）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截斷過長頁面）

注意事項：

- 透過 `tools.web.fetch.enabled` 啟用。
- `maxChars` 會受 `tools.web.fetch.maxCharsCap` 限制（預設 50000）。
- 回應會被快取（預設 15 分鐘）。
- 對於大量 JS 的網站，請優先使用 browser 工具。
- 設定方式請見 [Web tools](/tools/web)。
- 可選的反機器人備援請見 [Firecrawl](/tools/firecrawl)。

### `browser`

控制由 OpenClaw 管理的專用 browser。

核心動作：

- `status`、`start`、`stop`、`tabs`、`open`、`focus`、`close`
- `snapshot`（aria/ai）
- `screenshot`（回傳 image 區塊 + `MEDIA:<path>`）
- `act`（UI 動作：click/type/press/hover/drag/select/fill/resize/wait/evaluate）
- `navigate`、`console`、`pdf`、`upload`、`dialog`

設定檔管理：

- `profiles` — 列出所有 browser 設定檔與狀態
- `create-profile` — 建立新設定檔並自動配置連接埠（或 `cdpUrl`）
- `delete-profile` — 停止 browser、刪除使用者資料、從設定中移除（僅本機）
- `reset-profile` — 終止設定檔連接埠上的孤兒程序（僅本機）

常用參數：

- `profile`（選用；預設為 `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（選用；指定特定節點 id/名稱）
  注意事項：
- 需要 `browser.enabled=true`（預設為 `true`；設定 `false` 以停用）。
- 所有動作皆接受選用的 `profile` 參數以支援多實例。
- 省略 `profile` 時，會使用 `browser.defaultProfile`（預設為 "chrome"）。
- 設定檔名稱：僅限小寫英數與連字號（最長 64 字元）。
- 連接埠範圍：18800–18899（最多約 100 個設定檔）。
- 遠端設定檔僅支援附加（不可 start/stop/reset）。
- 若連線了具備 browser 能力的節點，工具可能會自動路由至該節點（除非你固定 `target`）。
- 安裝 Playwright 時，`snapshot` 預設為 `ai`；如需可存取性樹，請使用 `aria`。
- `snapshot` 亦支援角色快照選項（`interactive`、`compact`、`depth`、`selector`），會回傳如 `e12` 的參照。
- `act` 需要來自 `snapshot` 的 `ref`（AI 快照的數值 `12`，或角色快照的 `e12`）；罕見的 CSS 選擇器需求請使用 `evaluate`。
- 預設避免使用 `act` → `wait`；僅在例外情況（沒有可靠 UI 狀態可等待）時使用。
- `upload` 可選擇性傳入 `ref` 以在啟用後自動點擊。
- `upload` 亦支援 `inputRef`（aria 參照）或 `element`（CSS 選擇器）以直接設定 `<input type="file">`。

### `canvas`

驅動節點 Canvas（present、eval、snapshot、A2UI）。

核心動作：

- `present`、`hide`、`navigate`、`eval`
- `snapshot`（回傳 image 區塊 + `MEDIA:<path>`）
- `a2ui_push`、`a2ui_reset`

注意事項：

- 底層使用閘道器 `node.invoke`。
- 若未提供 `node`，工具會選擇預設值（單一連線節點或本機 mac 節點）。
- A2UI 僅支援 v0.8（沒有 `createSurface`）；CLI 會拒絕 v0.9 的 JSONL 並回報行錯誤。
- 快速驗證：`openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`。

### `nodes`

探索並指定已配對的節點；傳送通知；擷取相機/螢幕。

核心動作：

- `status`、`describe`
- `pending`、`approve`、`reject`（配對）
- `notify`（macOS `system.notify`）
- `run`（macOS `system.run`）
- `camera_snap`、`camera_clip`、`screen_record`
- `location_get`

注意事項：

- 相機/螢幕指令需要節點應用程式在前景。
- 影像會回傳 image 區塊 + `MEDIA:<path>`。
- 影片會回傳 `FILE:<path>`（mp4）。
- 位置會回傳 JSON 載荷（lat/lon/accuracy/timestamp）。
- `run` 參數：`command` argv 陣列；選用 `cwd`、`env`（`KEY=VAL`）、`commandTimeoutMs`、`invokeTimeoutMs`、`needsScreenRecording`。

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

使用設定的影像模型分析影像。

核心參數：

- `image`（必填路徑或 URL）
- `prompt`（選用；預設為 "Describe the image."）
- `model`（選用覆寫）
- `maxBytesMb`（選用大小上限）

注意事項：

- 僅在已設定 `agents.defaults.imageModel`（主要或備援），或可由預設模型 + 已設定的驗證推斷出隱含影像模型時可用（盡力配對）。
- 直接使用影像模型（與主要聊天模型無關）。

### `message`

跨 Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 傳送訊息與頻道動作。

核心動作：

- `send`（文字 + 選用媒體；MS Teams 亦支援 `card` 以使用 Adaptive Cards）
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

- `send` 會透過 Gateway 閘道器 路由 WhatsApp；其他頻道為直連。
- `poll` 會為 WhatsApp 與 MS Teams 使用 Gateway 閘道器；Discord 投票為直連。
- 當訊息工具呼叫綁定至作用中的聊天工作階段時，傳送會受限於該工作階段的目標，以避免跨情境外洩。

### `cron`

管理 Gateway 閘道器 的 cron 工作與喚醒。

核心動作：

- `status`、`list`
- `add`、`update`、`remove`、`run`、`runs`
- `wake`（佇列系統事件 + 選用立即心跳）

注意事項：

- `add` 需要完整的 cron 工作物件（與 `cron.add` RPC 相同結構）。
- `update` 使用 `{ jobId, patch }`（為相容性接受 `id`）。

### `gateway`

重新啟動或套用更新至執行中的 Gateway 閘道器 程序（就地）。

核心動作：

- `restart`（授權 + 傳送 `SIGUSR1` 以進行行內重新啟動；`openclaw gateway` 就地重新啟動）
- `config.get` / `config.schema`
- `config.apply`（驗證 + 寫入設定 + 重新啟動 + 喚醒）
- `config.patch`（合併部分更新 + 重新啟動 + 喚醒）
- `update.run`（執行更新 + 重新啟動 + 喚醒）

注意事項：

- 使用 `delayMs`（預設 2000）以避免中斷進行中的回覆。
- `restart` 預設停用；以 `commands.restart: true` 啟用。

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

列出工作階段、檢視逐字稿歷史，或傳送至另一個工作階段。

核心參數：

- `sessions_list`：`kinds?`、`limit?`、`activeMinutes?`、`messageLimit?`（0 = 無）
- `sessions_history`：`sessionKey`（或 `sessionId`）、`limit?`、`includeTools?`
- `sessions_send`：`sessionKey`（或 `sessionId`）、`message`、`timeoutSeconds?`（0 = fire-and-forget）
- `sessions_spawn`：`task`、`label?`、`agentId?`、`model?`、`runTimeoutSeconds?`、`cleanup?`
- `session_status`：`sessionKey?`（預設為目前；接受 `sessionId`）、`model?`（`default` 會清除覆寫）

注意事項：

- `main` 是標準的直接聊天鍵；全域/未知會被隱藏。
- `messageLimit > 0` 會擷取每個工作階段的最後 N 則訊息（會過濾工具訊息）。
- 當 `timeoutSeconds > 0` 時，`sessions_send` 會等待最終完成。
- 傳遞/公告會在完成後進行，且為盡力而為；`status: "ok"` 確認的是代理程式執行完成，而非公告已送達。
- `sessions_spawn` 會啟動子代理程式執行，並將公告回覆張貼回請求者聊天。
- `sessions_spawn` 為非阻塞，會立即回傳 `status: "accepted"`。
- `sessions_send` 會執行回覆往返（回覆 `REPLY_SKIP` 以停止；最大回合由 `session.agentToAgent.maxPingPongTurns` 設定，0–5）。
- 往返後，目標代理程式會執行 **公告步驟**；回覆 `ANNOUNCE_SKIP` 以抑制公告。

### `agents_list`

列出目前工作階段可用 `sessions_spawn` 指定的代理程式 id。

注意事項：

- 結果受每個代理程式的允許清單限制（`agents.list[].subagents.allowAgents`）。
- 當設定 `["*"]` 時，工具會包含所有已設定的代理程式並標記 `allowAny: true`。

## 參數（共用）

由 Gateway 閘道器 支援的工具（`canvas`、`nodes`、`cron`）：

- `gatewayUrl`（預設 `ws://127.0.0.1:18789`）
- `gatewayToken`（若啟用驗證）
- `timeoutMs`

注意：當設定 `gatewayUrl` 時，請明確包含 `gatewayToken`。工具不會繼承設定
或環境中的覆寫憑證，缺少明確憑證會視為錯誤。

Browser 工具：

- `profile`（選用；預設為 `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（選用；固定特定節點 id/名稱）

## 建議的代理程式流程

Browser 自動化：

1. `browser` → `status` / `start`
2. `snapshot`（ai 或 aria）
3. `act`（click/type/press）
4. 如需視覺確認，使用 `screenshot`

Canvas 繪製：

1. `canvas` → `present`
2. `a2ui_push`（選用）
3. `snapshot`

節點指定：

1. `nodes` → `status`
2. 在選定的節點上執行 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 安全性

- 避免直接使用 `system.run`；僅在明確取得使用者同意時，使用 `nodes` → `run`。
- 尊重使用者對相機/螢幕擷取的同意。
- 在呼叫媒體指令前，使用 `status/describe` 以確保權限。

## 工具如何呈現給代理程式

工具會透過兩個平行管道揭露：

1. **系統提示文字**：人類可讀的清單 + 指引。
2. **工具結構描述**：傳送至模型 API 的結構化函式定義。

這表示代理程式同時能看到「有哪些工具」以及「如何呼叫它們」。如果某個工具
未出現在系統提示或結構描述中，模型就無法呼叫它。
