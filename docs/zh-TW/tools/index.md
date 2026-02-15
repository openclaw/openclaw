```yaml
---
summary: "OpenClaw 的智慧代理工具介面 (瀏覽器、畫布、節點、訊息、排程)，取代舊版 `openclaw-*` Skills"
read_when:
  - 新增或修改智慧代理工具時
  - 淘汰或變更 `openclaw-*` Skills 時
title: "工具"
---

# 工具 (OpenClaw)

OpenClaw 為瀏覽器、畫布、節點和排程公開了**一流的智慧代理工具**。
這些工具取代了舊版 `openclaw-*` Skills：這些工具都是強型別的，不需使用 shell，
且智慧代理應直接依賴它們。

## 停用工具

您可以透過 `openclaw.json` 中的 `tools.allow` / `tools.deny` 全域允許/拒絕工具
（拒絕優先）。這會防止不允許的工具傳送給模型供應商。

```json5
{
  tools: { deny: ["browser"] },
}
```

注意事項：

- 比對不區分大小寫。
- `*` 萬用字元支援（`"*"` 表示所有工具）。
- 如果 `tools.allow` 僅引用未知或未載入的外掛程式工具名稱，OpenClaw 會記錄警告並忽略允許清單，以便核心工具保持可用。

## 工具設定檔（基本允許清單）

`tools.profile` 在 `tools.allow`/`tools.deny` 之前設定**基本工具允許清單**。
智慧代理層級覆寫：`agents.list[].tools.profile`。

設定檔：

- `minimal`：僅限 `session_status`
- `coding`：`group:fs`、`group:runtime`、`group:sessions`、`group:memory`、`image`
- `messaging`：`group:messaging`、`sessions_list`、`sessions_history`、`sessions_send`、`session_status`
- `full`：無限制（與未設定相同）

範例（預設僅限訊息，也允許 Slack + Discord 工具）：

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

範例（程式設計設定檔，但全域拒絕 exec/process）：

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

範例（全域程式設計設定檔，僅限訊息的支援智慧代理）：

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

## 供應商專屬工具政策

使用 `tools.byProvider` 可以**進一步限制**特定供應商（或單一 `provider/model`）的工具，而無需更改您的全域預設設定。
智慧代理層級覆寫：`agents.list[].tools.byProvider`。

這會在基本工具設定檔**之後**，允許/拒絕清單**之前**應用，
因此它只能縮小工具集。
供應商鍵名接受 `provider`（例如 `google-antigravity`）或
`provider/model`（例如 `openai/gpt-5.2`）。

範例（保留全域程式設計設定檔，但 Google Antigravity 僅限最少工具）：

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

範例（針對不穩定端點的供應商/模型專屬允許清單）：

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

範例（單一供應商的智慧代理專屬覆寫）：

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

工具政策（全域、智慧代理、沙箱）支援展開為多個工具的 `group:*` 項目。
在 `tools.allow` / `tools.deny` 中使用這些項目。

可用群組：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:web`：`web_search`、`web_fetch`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`Gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有內建 OpenClaw 工具（不包括供應商外掛程式）

範例（僅允許檔案工具 + 瀏覽器）：

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## 外掛程式 + 工具

外掛程式可以註冊核心集之外的**額外工具**（以及 CLI 指令）。
請參閱 [外掛程式](/tools/plugin) 以了解安裝 + 設定，並參閱 [Skills](/tools/skills) 以了解工具使用指南如何注入到提示中。某些外掛程式會隨工具一起提供其自身的 Skills（例如，語音通話外掛程式）。

選用的外掛程式工具：

- [Lobster](/tools/lobster)：帶有可恢復批准的型別工作流程執行時（需要 Gateway 主機上的 Lobster CLI）。
- [LLM Task](/tools/llm-task)：用於結構化工作流程輸出的僅 JSON LLM 步驟（選用的綱要驗證）。

## 工具清單

### `apply_patch`

跨一個或多個檔案套用結構化修補程式。用於多區段編輯。
實驗性：透過 `tools.exec.applyPatch.enabled` 啟用（僅限 OpenAI 模型）。

### `exec`

在工作區中執行 shell 指令。

核心參數：

- `command` (必填)
- `yieldMs` (逾時後自動進入背景執行，預設 10000)
- `background` (立即進入背景執行)
- `timeout` (秒；如果超出則終止程序，預設 1800)
- `elevated` (布林值；如果啟用/允許提升模式，則在主機上執行；僅在智慧代理為沙箱隔離時才會改變行為)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node` 的節點 ID/名稱)
- 需要真實的 TTY？設定 `pty: true`。

注意事項：

- 在背景執行時，回傳 `status: "running"` 和 `sessionId`。
- 使用 `process` 輪詢/記錄/寫入/終止/清除背景工作階段。
- 如果不允許 `process`，`exec` 會同步執行並忽略 `yieldMs`/`background`。
- `elevated` 受 `tools.elevated` 和任何 `agents.list[].tools.elevated` 覆寫的限制（兩者都必須允許），並且是 `host=gateway` + `security=full` 的別名。
- `elevated` 僅在智慧代理為沙箱隔離時才會改變行為（否則為無操作）。
- `host=node` 可以針對 macOS 配套應用程式或無頭節點主機 (`openclaw node run`)。
- Gateway/節點批准和允許清單：[執行批准](/tools/exec-approvals)。

### `process`

管理背景執行工作階段。

核心動作：

- `list`、`poll`、`log`、`write`、`kill`、`clear`、`remove`

注意事項：

- 完成時，`poll` 會回傳新的輸出和結束狀態。
- `log` 支援基於行的 `offset`/`limit` (省略 `offset` 以取得最後 N 行)。
- `process` 作用範圍為每個智慧代理；其他智慧代理的工作階段不可見。

### `web_search`

使用 Brave Search API 搜尋網路。

核心參數：

- `query` (必填)
- `count` (1–10；預設來自 `tools.web.search.maxResults`)

注意事項：

- 需要 Brave API 鍵（建議：`openclaw configure --section web`，或設定 `BRAVE_API_KEY`）。
- 透過 `tools.web.search.enabled` 啟用。
- 回應會被快取（預設 15 分鐘）。
- 請參閱 [Web 工具](/tools/web) 以進行設定。

### `web_fetch`

從 URL 擷取並提取可讀內容（HTML → Markdown/文字）。

核心參數：

- `url` (必填)
- `extractMode` (`markdown` | `text`)
- `maxChars` (截斷長頁面)

注意事項：

- 透過 `tools.web.fetch.enabled` 啟用。
- `maxChars` 受 `tools.web.fetch.maxCharsCap` 的限制（預設 50000）。
- 回應會被快取（預設 15 分鐘）。
- 對於 JavaScript 繁重的網站，請優先使用瀏覽器工具。
- 請參閱 [Web 工具](/tools/web) 以進行設定。
- 請參閱 [Firecrawl](/tools/firecrawl) 以了解選用的反機器人備用方案。

### `browser`

控制專用的 OpenClaw 管理瀏覽器。

核心動作：

- `status`、`start`、`stop`、`tabs`、`open`、`focus`、`close`
- `snapshot` (aria/ai)
- `screenshot` (回傳圖片區塊 + `MEDIA:<path>`)
- `act` (UI 動作：點擊/輸入/按下/懸停/拖曳/選取/填寫/調整大小/等待/評估)
- `navigate`、`console`、`pdf`、`upload`、`dialog`

設定檔管理：

- `profiles` — 列出所有瀏覽器設定檔及其狀態
- `create-profile` — 建立具有自動分配埠號（或 `cdpUrl`）的新設定檔
- `delete-profile` — 停止瀏覽器、刪除使用者資料、從設定中移除（僅限本地）
- `reset-profile` — 終止設定檔埠號上的孤立程序（僅限本地）

常用參數：

- `profile` (選填；預設為 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (選填；選取特定的節點 ID/名稱)
注意事項：
- 需要 `browser.enabled=true`（預設為 `true`；設定 `false` 則停用）。
- 所有動作都接受選用的 `profile` 參數以支援多實例。
- 當省略 `profile` 時，使用 `browser.defaultProfile`（預設為 "chrome"）。
- 設定檔名稱：僅限小寫英數字元 + 連字號（最多 64 個字元）。
- 埠號範圍：18800-18899（最多約 100 個設定檔）。
- 遠端設定檔僅限附加（無啟動/停止/重設）。
- 如果連接了支援瀏覽器的節點，工具可能會自動路由到該節點（除非您固定 `target`）。
- 安裝 Playwright 時，`snapshot` 預設為 `ai`；使用 `aria` 取得無障礙樹狀結構。
- `snapshot` 也支援角色快照選項 (`interactive`、`compact`、`depth`、`selector`)，這些選項會回傳 `e12` 等參考。
- `act` 需要 `snapshot` 中的 `ref`（來自 AI 快照的數字 `12`，或來自角色快照的 `e12`）；在極少數需要 CSS 選擇器的情況下，使用 `evaluate`。
- 預設避免 `act` → `wait`；僅在特殊情況下使用（沒有可靠的 UI 狀態可供等待）。
- `upload` 可以選用傳遞 `ref` 以在武裝後自動點擊。
- `upload` 也支援 `inputRef` (aria ref) 或 `element` (CSS 選擇器) 以直接設定 `<input type="file">`。

### `canvas`

驅動節點畫布（呈現、評估、快照、A2UI）。

核心動作：

- `present`、`hide`、`navigate`、`eval`
- `snapshot` (回傳圖片區塊 + `MEDIA:<path>`)
- `a2ui_push`、`a2ui_reset`

注意事項：

- 底層使用 Gateway `node.invoke`。
- 如果未提供 `node`，工具會選擇一個預設值（單一連接節點或本地 Mac 節點）。
- A2UI 僅限 v0.8 (無 `createSurface`)；CLI 會拒絕帶有行錯誤的 v0.9 JSONL。
- 快速測試：`openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`。

### `nodes`

探索並目標配對的節點；傳送通知；捕捉相機/螢幕。

核心動作：

- `status`、`describe`
- `pending`、`approve`、`reject` (配對)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`、`camera_clip`、`screen_record`
- `location_get`

注意事項：

- 相機/螢幕指令需要節點應用程式在前景執行。
- 圖片回傳圖片區塊 + `MEDIA:<path>`。
- 影片回傳 `FILE:<path>` (mp4)。
- 位置回傳 JSON 酬載 (緯度/經度/準確度/時間戳記)。
- `run` 參數：`command` argv 陣列；選填 `cwd`、`env` (`KEY=VAL`)、`commandTimeoutMs`、`invokeTimeoutMs`、`needsScreenRecording`。

範例 (`run`)：

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

使用已設定的圖像模型分析圖像。

核心參數：

- `image` (必填路徑或 URL)
- `prompt` (選填；預設為「描述此圖像。」)
- `model` (選用覆寫)
- `maxBytesMb` (選用大小限制)

注意事項：

- 僅在 `agents.defaults.imageModel` 已設定（主要或備用），或當可從您的預設模型 + 已設定的驗證（盡力配對）推斷出隱式圖像模型時才可用。
- 直接使用圖像模型（獨立於主要聊天模型）。

### `message`

跨 Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 傳送訊息和頻道動作。

核心動作：

- `send` (文字 + 選用媒體；MS Teams 也支援用於 Adaptive Cards 的 `card`)
- `poll` (WhatsApp/Discord/MS Teams 投票)
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

- `send` 透過 Gateway 路由 WhatsApp；其他頻道直接傳送。
- `poll` 使用 Gateway 進行 WhatsApp 和 MS Teams；Discord 投票直接傳送。
- 當訊息工具呼叫綁定到活動聊天工作階段時，傳送會受限於該工作階段的目標，以避免跨上下文洩漏。

### `cron`

管理 Gateway 排程工作和喚醒。

核心動作：

- `status`、`list`
- `add`、`update`、`remove`、`run`、`runs`
- `wake` (將系統事件排入佇列 + 選用立即心跳)

注意事項：

- `add` 預期一個完整的排程工作物件 (與 `cron.add` RPC 的綱要相同)。
- `update` 使用 `{ jobId, patch }` (`id` 為相容性而接受)。

### `gateway`

重新啟動或對執行中的 Gateway 程序應用更新（就地執行）。

核心動作：

- `restart` (授權 + 傳送 `SIGUSR1` 以進行程序內重新啟動；`openclaw gateway` 就地重新啟動)
- `config.get` / `config.schema`
- `config.apply` (驗證 + 寫入設定 + 重新啟動 + 喚醒)
- `config.patch` (合併部分更新 + 重新啟動 + 喚醒)
- `update.run` (執行更新 + 重新啟動 + 喚醒)

注意事項：

- 使用 `delayMs` (預設為 2000) 以避免中斷正在進行的回應。
- `restart` 預設為停用；透過 `commands.restart: true` 啟用。

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

列出工作階段、檢查對話記錄，或傳送至另一個工作階段。

核心參數：

- `sessions_list`：`kinds?`、`limit?`、`activeMinutes?`、`messageLimit?` (0 = 無)
- `sessions_history`：`sessionKey` (或 `sessionId`)、`limit?`、`includeTools?`
- `sessions_send`：`sessionKey` (或 `sessionId`)、`message`、`timeoutSeconds?` (0 = 即發即忘)
- `sessions_spawn`：`task`、`label?`、`agentId?`、`model?`、`runTimeoutSeconds?`、`cleanup?`
- `session_status`：`sessionKey?` (預設目前；接受 `sessionId`)、`model?` (`default` 清除覆寫)

注意事項：

- `main` 是規範的直接聊天鍵；全域/未知是隱藏的。
- `messageLimit > 0` 會擷取每個工作階段的最後 N 則訊息（已篩選工具訊息）。
- `sessions_send` 在 `timeoutSeconds > 0` 時等待最終完成。
- 遞送/公告發生在完成之後，且為盡力而為；`status: "ok"` 確認智慧代理執行完成，而非公告已遞送。
- `sessions_spawn` 會啟動子智慧代理執行，並將公告回應張貼回請求者的聊天室。
- `sessions_spawn` 是非阻塞的，並立即回傳 `status: "accepted"`。
- `sessions_send` 執行回應乒乓 (回覆 `REPLY_SKIP` 以停止；最大回合數透過 `session.agentToAgent.maxPingPongTurns`，0–5)。
- 在乒乓之後，目標智慧代理會執行**公告步驟**；回覆 `ANNOUNCE_SKIP` 以抑制公告。

### `agents_list`

列出目前工作階段可透過 `sessions_spawn` 目標的智慧代理 ID。

注意事項：

- 結果受限於每個智慧代理允許清單 (`agents.list[].subagents.allowAgents`)。
- 當設定 `["*"]` 時，工具會包含所有已設定的智慧代理，並標記 `allowAny: true`。

## 參數（常用）

Gateway 支援的工具（`canvas`、`nodes`、`cron`）：

- `gatewayUrl` (預設 `ws://127.0.0.1:18789`)
- `gatewayToken` (如果啟用驗證)
- `timeoutMs`

注意：當設定 `gatewayUrl` 時，請明確包含 `gatewayToken`。工具不會繼承設定
或環境憑證以進行覆寫，且缺少明確憑證是錯誤。

瀏覽器工具：

- `profile` (選填；預設為 `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (選填；固定特定的節點 ID/名稱)

## 推薦的智慧代理流程

瀏覽器自動化：

1. `browser` → `status` / `start`
2. `snapshot` (ai 或 aria)
3. `act` (點擊/輸入/按下)
4. 如果您需要視覺確認，請使用 `screenshot`

畫布渲染：

1. `canvas` → `present`
2. `a2ui_push` (選填)
3. `snapshot`

節點目標設定：

1. `nodes` → `status`
2. 在選定的節點上 `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 安全性

- 避免直接 `system.run`；僅在明確使用者同意下使用 `nodes` → `run`。
- 尊重使用者對相機/螢幕捕捉的同意。
- 在叫用媒體指令之前，使用 `status/describe` 確保權限。

## 工具如何呈現給智慧代理

工具透過兩個平行頻道公開：

1. **系統提示文字**：人類可讀的清單 + 指導。
2. **工具綱要**：傳送給模型 API 的結構化函數定義。

這表示智慧代理會看到「存在哪些工具」和「如何呼叫它們」。如果工具
未出現在系統提示或綱要中，模型就無法呼叫它。
```
