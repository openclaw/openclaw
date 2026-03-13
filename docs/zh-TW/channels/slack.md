---
summary: Slack setup and runtime behavior (Socket Mode + HTTP Events API)
read_when:
  - Setting up Slack or debugging Slack socket/HTTP mode
title: Slack
---

# Slack

狀態：已準備好在 Slack 應用程式整合中用於 DMs 和頻道。預設模式為 Socket Mode；同時也支援 HTTP Events API 模式。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Slack 直接訊息預設為配對模式。
  </Card>
  <Card title="斜線指令" icon="terminal" href="/tools/slash-commands">
    原生指令行為和指令目錄。
  </Card>
  <Card title="頻道故障排除" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷和修復手冊。
  </Card>
</CardGroup>

## 快速設定

<Tabs>
  <Tab title="Socket Mode (default)">
    <Steps>
      <Step title="建立 Slack 應用程式和 token">
        在 Slack 應用程式設定中：

- 啟用 **Socket Mode** - 創建 **App Token** (`xapp-...`) 並使用 `connections:write` - 安裝應用程式並複製 **Bot Token** (`xoxb-...`)
  </Step>

<Step title="設定 OpenClaw">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

[[BLOCK_1]]  
Env fallback (default account only):  
[[INLINE_1]]

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

</Step>

<Step title="訂閱應用程式事件">
        訂閱機器人事件以便：

- `app_mention` - `message.channels`, `message.groups`, `message.im`, `message.mpim` - `reaction_added`, `reaction_removed` - `member_joined_channel`, `member_left_channel` - `channel_rename` - `pin_added`, `pin_removed`

也啟用 App Home **Messages Tab** 以便於直接訊息 (DMs)。  
 </Step>

<Step title="啟動閘道">

```bash
openclaw gateway
```

</Step>
    </Steps>

</Tab>

<Tab title="HTTP 事件 API 模式">
    <Steps>
      <Step title="為 Slack 應用程式設定 HTTP">

- 設定模式為 HTTP (`channels.slack.mode="http"`) - 複製 Slack **簽名密鑰** - 將事件訂閱 + 互動 + Slash 指令的請求 URL 設定為相同的 webhook 路徑（預設 `/slack/events`）

</Step>

<Step title="設定 OpenClaw HTTP 模式">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

</Step>

<Step title="為多帳戶 HTTP 使用唯一的 webhook 路徑">
        支援每個帳戶的 HTTP 模式。

給每個帳戶一個獨特的 `webhookPath`，以避免註冊衝突。
</Step>
</Steps>

</Tab>
</Tabs>

## Token model

- `botToken` + `appToken` 是 Socket Mode 所需的。
- HTTP 模式需要 `botToken` + `signingSecret`。
- 設定的 token 會覆蓋環境變數的回退設定。
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` 的環境變數回退僅適用於預設帳戶。
- `userToken` (`xoxp-...`) 僅限於設定（無環境變數回退），並預設為唯讀行為 (`userTokenReadOnly: true`)。
- 可選：如果您希望發送的消息使用活動代理身份（自訂 `username` 和圖示），請添加 `chat:write.customize`。`icon_emoji` 使用 `:emoji_name:` 語法。

<Tip>
對於動作/目錄讀取，當設定時可以優先使用用戶 token。對於寫入，仍然優先使用機器人 token；只有在 `userTokenReadOnly: false` 且機器人 token 不可用時，才允許使用用戶 token 進行寫入。
</Tip>

## 存取控制與路由

<Tabs>
  <Tab title="DM 政策">
    `channels.slack.dmPolicy` 控制 DM 存取 (舊版: `channels.slack.dm.policy`):

- `pairing` (預設)
  - `allowlist`
  - `open` (需要 `channels.slack.allowFrom` 來包含 `"*"`; 遺留: `channels.slack.dm.allowFrom`)
  - `disabled`

DM flags:

- `dm.enabled` (預設為 true)
  - `channels.slack.allowFrom` (首選)
  - `dm.allowFrom` (舊版)
  - `dm.groupEnabled` (群組私訊預設為 false)
  - `dm.groupChannels` (可選的 MPIM 白名單)

[[BLOCK_1]]  
多帳戶優先權：  
[[BLOCK_1]]

- `channels.slack.accounts.default.allowFrom` 僅適用於 `default` 帳戶。
  - 命名帳戶在其自己的 `allowFrom` 未設定時會繼承 `channels.slack.allowFrom`。
  - 命名帳戶不會繼承 `channels.slack.accounts.default.allowFrom`。

在 DM 中配對使用 `openclaw pairing approve slack <code>`。

</Tab>

<Tab title="頻道政策">
    `channels.slack.groupPolicy` 控制頻道處理：

- `open`
  - `allowlist`
  - `disabled`

Channel allowlist 位於 `channels.slack.channels` 並應使用穩定的頻道 ID。

執行時注意：如果 `channels.slack` 完全缺失（僅環境設置），執行時將回退到 `groupPolicy="allowlist"` 並記錄警告（即使 `channels.defaults.groupPolicy` 已設置）。

Name/ID 解析：

- 頻道允許清單條目和 DM 允許清單條目在啟動時解析，當 token 存取允許時
  - 未解析的頻道名稱條目將保持為設定狀態，但預設情況下會被忽略以進行路由
  - 入站授權和頻道路由預設為 ID 優先；直接的使用者名稱/slug 匹配需要 `channels.slack.dangerouslyAllowNameMatching: true`

</Tab>

<Tab title="提及和頻道用戶">
    頻道消息預設為提及限制。

[[BLOCK_1]]

- 明確的應用程式提及 (`<@botId>`)
  - 提及正則表達式模式 (`agents.list[].groupChat.mentionPatterns`, 備用 `messages.groupChat.mentionPatterns`)
  - 隱式回覆機器人線程行為

每通道控制 (`channels.slack.channels.<id>`; 僅透過啟動解析度或 `dangerouslyAllowNameMatching` 的名稱)：

- `requireMention`
  - `users` (允許清單)
  - `allowBots`
  - `skills`
  - `systemPrompt`
  - `tools`, `toolsBySender`
  - `toolsBySender` 金鑰格式: `id:`, `e164:`, `username:`, `name:`，或 `"*"` 通配符
    (舊版無前綴的金鑰仍然僅對應到 `id:`)

</Tab>
</Tabs>

## 指令與斜線行為

- Slack 的原生命令自動模式為 **關閉**（`commands.native: "auto"` 不啟用 Slack 原生命令）。
- 使用 `channels.slack.commands.native: true`（或全域 `commands.native: true`）來啟用原生 Slack 命令處理程序。
- 當原生命令啟用時，請在 Slack 中註冊匹配的斜線命令 (`/<command>` 名稱)，有一個例外：
  - 註冊 `/agentstatus` 作為狀態命令（Slack 保留 `/status`）
- 如果未啟用原生命令，您可以通過 `channels.slack.slashCommand` 執行單個設定的斜線命令。
- 原生參數選單現在會根據其渲染策略進行調整：
  - 最多 5 個選項：按鈕區塊
  - 6-100 個選項：靜態選擇選單
  - 超過 100 個選項：外部選擇，當互動選項處理程序可用時進行異步選項過濾
  - 如果編碼的選項值超過 Slack 限制，流程將回退到按鈕
- 對於長選項有效載荷，斜線命令參數選單在發送所選值之前會使用確認對話框。

預設斜線指令設定：

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

Slash 會話使用隔離的金鑰：

`agent:<agentId>:slack:slash:<userId>`

並仍然針對目標對話會話執行命令路由 (`CommandTargetSessionKey`)。

## Threading, sessions, and reply tags

- DMs 路由為 `direct`; 頻道為 `channel`; MPIMs 為 `group`。
- 使用預設 `session.dmScope=main`，Slack DMs 會合併到代理主會話中。
- 頻道會話: `agent:<agentId>:slack:channel:<channelId>`。
- 當適用時，主題回覆可以創建主題會話後綴 (`:thread:<threadTs>`)。
- `channels.slack.thread.historyScope` 的預設為 `thread`; `thread.inheritParent` 的預設為 `false`。
- `channels.slack.thread.initialHistoryLimit` 控制在新主題會話開始時提取多少現有主題消息（預設 `20`; 設定 `0` 以禁用）。

[[BLOCK_1]]  
回覆串控制：  
[[BLOCK_1]]

- `channels.slack.replyToMode`: `off|first|all` (預設 `off`)
- `channels.slack.replyToModeByChatType`: 每 `direct|group|channel`
- 直接聊天的舊版備援: `channels.slack.dm.replyToMode`

手動回覆標籤是支援的：

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

注意：`replyToMode="off"` 會禁用 Slack 中的 **所有** 回覆串，包括明確的 `[[reply_to_*]]` 標籤。這與 Telegram 不同，因為在 `"off"` 模式下，明確的標籤仍然會被尊重。這種差異反映了平台的串接模型：Slack 的串接會隱藏來自頻道的訊息，而 Telegram 的回覆則會在主要聊天流中保持可見。

## 媒體、分塊與傳遞

<AccordionGroup>
  <Accordion title="進口附件">
    Slack 檔案附件是從 Slack 主機的私有 URL 下載（使用 token 驗證的請求流程），並在成功獲取且大小限制允許的情況下寫入媒體儲存區。

執行時的入站大小上限預設為 `20MB`，除非被 `channels.slack.mediaMaxMb` 覆蓋。

</Accordion>

<Accordion title="外發文字與檔案">
    - 文字區塊使用 `channels.slack.textChunkLimit` (預設 4000)
    - `channels.slack.chunkMode="newline"` 啟用段落優先分割
    - 檔案發送使用 Slack 上傳 API，並可以包含主題回覆 (`thread_ts`)
    - 外發媒體上限遵循 `channels.slack.mediaMaxMb` 的設定；否則頻道發送使用媒體管道的 MIME 類型預設值
</Accordion>

<Accordion title="交付目標">
    首選明確目標：

- `user:<id>` 用於私訊
  - `channel:<id>` 用於頻道

透過 Slack 會話 API 開啟 Slack 直接訊息 (DM)，當發送給用戶目標時。

</Accordion>
</AccordionGroup>

## Actions and gates

Slack 的操作由 `channels.slack.actions.*` 控制。

當前 Slack 工具中的可用操作群組：

| 群組         | 預設 |
| ------------ | ---- |
| 訊息         | 啟用 |
| 反應         | 啟用 |
| 置頂         | 啟用 |
| 成員資訊     | 啟用 |
| 表情符號列表 | 啟用 |

## 事件與操作行為

- 訊息編輯/刪除/串流廣播被映射為系統事件。
- 反應新增/移除事件被映射為系統事件。
- 成員加入/離開、頻道創建/重新命名，以及釘選新增/移除事件被映射為系統事件。
- 助手串流狀態更新（用於串流中的「正在輸入...」指示器）使用 `assistant.threads.setStatus` 並需要機器人範圍 `assistant:write`。
- `channel_id_changed` 可以在 `configWrites` 啟用時遷移頻道設定鍵。
- 頻道主題/目的元數據被視為不受信的上下文，並可以注入到路由上下文中。
- 區塊操作和模態互動會發出結構化的 `Slack interaction: ...` 系統事件，並帶有豐富的有效載荷欄位：
  - 區塊操作：選擇的值、標籤、選擇器值，以及 `workflow_*` 元數據
  - 模態 `view_submission` 和 `view_closed` 事件，帶有路由頻道元數據和表單輸入

## Ack 反應

`ackReaction` 在 OpenClaw 處理進來的訊息時會發送一個確認表情符號。

[[BLOCK_1]]  
解決順序：  
[[BLOCK_1]]

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- agent identity emoji fallback (`agents.list[].identity.emoji`, 否則 "👀")

[[BLOCK_1]]

- Slack 期望使用短碼（例如 `"eyes"`）。
- 使用 `""` 來禁用該 Slack 帳戶或全域的反應。

## Typing reaction fallback

`typingReaction` 在 OpenClaw 處理回覆時，會對進入的 Slack 訊息添加一個臨時反應，然後在執行結束時將其移除。當 Slack 原生助手的輸入狀態無法使用時，這是一個有用的備援，特別是在私訊中。

[[BLOCK_1]]  
解決順序：  
[[BLOCK_1]]

- `channels.slack.accounts.<accountId>.typingReaction`
- `channels.slack.typingReaction`

Notes:

- Slack 期望使用短程式碼（例如 `"hourglass_flowing_sand"`）。
- 反應是最佳努力，並且在回覆或失敗路徑完成後會自動嘗試清理。

## Manifest 和範圍檢查清單

<AccordionGroup>
  <Accordion title="Slack 應用程式清單範例">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "assistant:write",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

</Accordion>

<Accordion title="可選的使用者 token 範圍（讀取操作）">
    如果您設定 `channels.slack.userToken`，典型的讀取範圍包括：

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  - `channels:read`, `groups:read`, `im:read`, `mpim:read`
  - `users:read`
  - `reactions:read`
  - `pins:read`
  - `emoji:read`
  - `search:read` (如果您依賴 Slack 搜尋讀取)

</Accordion>
</AccordionGroup>

## 故障排除

<AccordionGroup>
  <Accordion title="在頻道中沒有回覆">
    請依序檢查：

- `groupPolicy`
  - 頻道允許清單 (`channels.slack.channels`)
  - `requireMention`
  - 每個頻道 `users` 允許清單

有用的指令：

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

</Accordion>

<Accordion title="DM 訊息被忽略">
    檢查：

- `channels.slack.dm.enabled`
  - `channels.slack.dmPolicy`（或舊版 `channels.slack.dm.policy`）
  - 配對批准 / 允許清單條目

```bash
openclaw pairing list slack
```

</Accordion>

<Accordion title="Socket 模式無法連接">
    驗證 Slack 應用程式設定中的機器人和應用程式 token 以及 Socket 模式的啟用狀態。
</Accordion>

<Accordion title="HTTP 模式未接收事件">
    驗證：

- 簽署密鑰
  - webhook 路徑
  - Slack 請求 URL（事件 + 互動 + 斜線指令）
  - 每個 HTTP 帳戶的唯一 `webhookPath`

</Accordion>

<Accordion title="本地/斜線指令未觸發">
    請確認您是否打算：

- 原生命令模式 (`channels.slack.commands.native: true`)，與在 Slack 中註冊的匹配斜線命令
  - 或單一斜線命令模式 (`channels.slack.slashCommand.enabled: true`)

也請檢查 `commands.useAccessGroups` 以及頻道/使用者允許清單。

</Accordion>
</AccordionGroup>

## Text streaming

OpenClaw 支援透過 Agents 和 AI Apps API 進行 Slack 原生文本串流。

`channels.slack.streaming` 控制即時預覽行為：

- `off`: 停用即時預覽串流。
- `partial` (預設): 用最新的部分輸出取代預覽文字。
- `block`: 附加分塊預覽更新。
- `progress`: 在生成過程中顯示進度狀態文字，然後發送最終文字。

`channels.slack.nativeStreaming` 控制 Slack 的原生串流 API (`chat.startStream` / `chat.appendStream` / `chat.stopStream`) 當 `streaming` 為 `partial` （預設值：`true`）。

禁用原生 Slack 串流（保留草稿預覽行為）：

```yaml
channels:
  slack:
    streaming: partial
    nativeStreaming: false
```

Legacy keys:

- `channels.slack.streamMode` (`replace | status_final | append`) 自動遷移至 `channels.slack.streaming`。
- 布林值 `channels.slack.streaming` 自動遷移至 `channels.slack.nativeStreaming`。

### Requirements

1. 在你的 Slack 應用程式設定中啟用 **Agents and AI Apps**。
2. 確保該應用程式具有 `assistant:write` 範圍。
3. 該訊息必須有可用的回覆串。串的選擇仍然遵循 `replyToMode`。

### Behavior

- 第一段文字開始一個串流 (`chat.startStream`)。
- 後續的文字段落會附加到同一個串流 (`chat.appendStream`)。
- 回覆的結尾會完成串流 (`chat.stopStream`)。
- 媒體和非文字的有效載荷將回退到正常交付。
- 如果串流在回覆中途失敗，OpenClaw 將對剩餘的有效載荷回退到正常交付。

## 設定參考指標

[[BLOCK_1]]

- [設定參考 - Slack](/gateway/configuration-reference#slack)

高信號 Slack 欄位：

- 模式/認證: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
- DM 存取: `dm.enabled`, `dmPolicy`, `allowFrom` (舊版: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
- 相容性切換: `dangerouslyAllowNameMatching` (緊急情況；除非必要，否則保持關閉)
- 頻道存取: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
- 線程/歷史: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- 傳遞: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `streaming`, `nativeStreaming`
- 操作/功能: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## Related

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [故障排除](/channels/troubleshooting)
- [設定](/gateway/configuration)
- [斜線指令](/tools/slash-commands)
