---
summary: "Slack 設定與執行行為 (Socket Mode + HTTP Events API)"
read_when:
  - 設定 Slack 或針對 Slack socket/HTTP 模式進行疑難排解時
title: "Slack"
---

# Slack

狀態：可供私訊 + 透過 Slack 應用程式整合的頻道在生產環境使用。預設模式為 Socket Mode；亦支援 HTTP Events API 模式。

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Slack 私訊預設使用 Pairing 模式。
  </Card>
  <Card title="Slash 指令" icon="terminal" href="/tools/slash-commands">
    原生指令行為與指令目錄。
  </Card>
  <Card title="頻道疑難排解" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷與修復指南。
  </Card>
</CardGroup>

## 快速開始

<Tabs>
  <Tab title="Socket Mode (預設)">
    <Steps>
      <Step title="建立 Slack 應用程式與權杖">
        在 Slack 應用程式設定中：

        - 啟用 **Socket Mode**
        - 建立 **App Token** (`xapp-...`) 並包含 `connections:write` 權限
        - 安裝應用程式並複製 **Bot Token** (`xoxb-...`)
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

        環境變數備援（僅限預設帳戶）：

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="訂閱應用程式事件">
        為機器人訂閱以下事件：

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        同時為私訊啟用 App Home 的 **Messages Tab**。
      </Step>

      <Step title="啟動 Gateway">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="HTTP Events API 模式">
    <Steps>
      <Step title="為 HTTP 設定 Slack 應用程式">

        - 將模式設定為 HTTP (`channels.slack.mode="http"`)
        - 複製 Slack **Signing Secret**
        - 將 Event Subscriptions + Interactivity + Slash command 的 Request URL 設定為相同的 Webhook 路徑（預設為 `/slack/events`）

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

      <Step title="多帳戶 HTTP 使用唯一的 Webhook 路徑">
        支援每個帳戶獨立的 HTTP 模式。

        為每個帳戶指定不同的 `webhookPath`，以避免註冊衝突。
      </Step>
    </Steps>

  </Tab>
</Tabs>

## 權杖模型

- Socket Mode 需要 `botToken` + `appToken`。
- HTTP 模式需要 `botToken` + `signingSecret`。
- 設定檔中的權杖會覆蓋環境變數備援。
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` 環境變數備援僅適用於預設帳戶。
- `userToken` (`xoxp-...`) 僅能透過設定檔指定（無環境變數備援），且預設為唯讀行為 (`userTokenReadOnly: true`)。

<Tip>
對於執行操作或讀取目錄，若已設定使用者權杖，可優先使用。對於寫入操作，仍優先使用機器人權杖；僅在 `userTokenReadOnly: false` 且機器人權杖不可用時，才允許使用使用者權杖寫入。
</Tip>

## 存取控制與路由

<Tabs>
  <Tab title="私訊政策">
    `channels.slack.dm.policy` 控制私訊存取：

    - `pairing` (預設)
    - `allowlist`
    - `open` (需要 `dm.allowFrom` 包含 `"*"` )
    - `disabled`

    私訊標記：

    - `dm.enabled` (預設為 true)
    - `dm.allowFrom`
    - `dm.groupEnabled` (群組私訊預設為 false)
    - `dm.groupChannels` (選填的 MPIM 允許清單)

    私訊中的 Pairing 使用 `openclaw pairing approve slack <code>`。

  </Tab>

  <Tab title="頻道政策">
    `channels.slack.groupPolicy` 控制頻道處理方式：

    - `open`
    - `allowlist`
    - `disabled`

    頻道允許清單位於 `channels.slack.channels` 下。

    執行時注意事項：如果完全缺少 `channels.slack`（僅透過環境變數設定）且未設定 `channels.defaults.groupPolicy`，執行時將回退到 `groupPolicy="open"` 並記錄警告。

    名稱/ID 解析：

    - 頻道允許清單項目和私訊允許清單項目會在啟動時解析（若權杖權限允許）
    - 未解析的項目將保留原設定

  </Tab>

  <Tab title="提及與頻道使用者">
    頻道訊息預設受到提及限制。

    提及來源：

    - 明確的應用程式提及 (`< @botId>`)
    - 提及正規表示式模式 (`agents.list[].groupChat.mentionPatterns`，備援為 `messages.groupChat.mentionPatterns`)
    - 隱含的機器人回覆執行緒行為

    個別頻道控制 (`channels.slack.channels.<id|name>`)：

    - `requireMention`
    - `users` (允許清單)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`

  </Tab>
</Tabs>

## 指令與 Slash 行為

- Slack 的原生指令自動模式為 **關閉** (`commands.native: "auto"` 不會啟用 Slack 原生指令)。
- 使用 `channels.slack.commands.native: true`（或全域 `commands.native: true`）啟用原生 Slack 指令處理常式。
- 啟用原生指令後，請在 Slack 中註冊對應的斜線指令 (`/<command>` 名稱)。
- 若未啟用原生指令，您可以透過 `channels.slack.slashCommand` 執行單個設定好的斜線指令。

預設斜線指令設定：

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

Slash 工作階段使用隔離的鍵名：

- `agent:<agentId>:slack:slash:<userId>`

且仍會針對目標對話工作階段 (`CommandTargetSessionKey`) 路由指令執行。

## 執行緒、工作階段與回覆標籤

- 私訊路由為 `direct`；頻道為 `channel`；MPIM 為 `group`。
- 使用預設的 `session.dmScope=main` 時，Slack 私訊會摺疊至智慧代理主工作階段。
- 頻道工作階段：`agent:<agentId>:slack:channel:<channelId>`。
- 執行緒回覆在適用時可建立執行緒工作階段後置字串 (`:thread:<threadTs>`)。
- `channels.slack.thread.historyScope` 預設為 `thread`；`thread.inheritParent` 預設為 `false`。
- `channels.slack.thread.initialHistoryLimit` 控制新執行緒工作階段開始時獲取的現有執行緒訊息數量（預設為 `20`；設定為 `0` 則停用）。

回覆執行緒控制：

- `channels.slack.replyToMode`: `off|first|all` (預設為 `off`)
- `channels.slack.replyToModeByChatType`: 依據 `direct|group|channel` 個別設定
- 舊版私訊回退設定：`channels.slack.dm.replyToMode`

支援手動回覆標籤：

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

## 媒體、分塊與傳遞

<AccordionGroup>
  <Accordion title="內送附件">
    Slack 檔案附件會從 Slack 託管的私人 URL（權杖驗證請求流程）下載，並在擷取成功且符合大小限制時寫入媒體儲存庫。

    執行時內送大小上限預設為 `20MB`，除非透過 `channels.slack.mediaMaxMb` 覆蓋。

  </Accordion>

  <Accordion title="外送文字與檔案">
    - 文字分塊使用 `channels.slack.textChunkLimit` (預設為 4000)
    - `channels.slack.chunkMode="newline"` 啟用段落優先切割
    - 檔案傳送使用 Slack 上傳 API，並可包含執行緒回覆 (`thread_ts`)
    - 外送媒體上限在有設定時遵循 `channels.slack.mediaMaxMb`；否則頻道傳送將使用媒體管線的 MIME 類型預設值
  </Accordion>

  <Accordion title="傳遞目標">
    偏好的明確目標：

    - `user:<id>` 用於私訊
    - `channel:<id>` 用於頻道

    傳送到使用者目標時，會透過 Slack 對話 API 開啟 Slack 私訊。

  </Accordion>
</AccordionGroup>

## 操作與閘門

Slack 操作由 `channels.slack.actions.*` 控制。

目前 Slack 工具中可用的操作群組：

| 群組       | 預設 |
| ---------- | ---- |
| messages   | 啟用 |
| reactions  | 啟用 |
| pins       | 啟用 |
| memberInfo | 啟用 |
| emojiList  | 啟用 |

## 事件與維運行為

- 訊息編輯/刪除/執行緒廣播會對應至系統事件。
- 表情符號回應新增/移除事件會對應至系統事件。
- 成員加入/離開、頻道建立/重新命名，以及圖釘新增/移除事件會對應至系統事件。
- 當啟用 `configWrites` 時，`channel_id_changed` 可以遷移頻道設定鍵。
- 頻道主題/用途中繼資料被視為不可信內容，可注入路由內容中。

## 資訊清單與權限範圍檢查清單

<AccordionGroup>
  <Accordion title="Slack 應用程式資訊清單範例">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "OpenClaw 的 Slack 連接器"
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
        "description": "傳送訊息給 OpenClaw",
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
        "mpim:history",
        "users:read",
        "app_mentions:read",
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

  <Accordion title="選填的使用者權杖權限範圍（讀取操作）">
    如果您設定了 `channels.slack.userToken`，典型的讀取權限範圍包括：

    - `channels:history`, `groups:history`, `im:history`, `mpim:history`
    - `channels:read`, `groups:read`, `im:read`, `mpim:read`
    - `users:read`
    - `reactions:read`
    - `pins:read`
    - `emoji:read`
    - `search:read` (如果您依賴 Slack 搜尋讀取)

  </Accordion>
</AccordionGroup>

## 疑難排解

<AccordionGroup>
  <Accordion title="頻道中沒有回覆">
    依序檢查：

    - `groupPolicy`
    - 頻道允許清單 (`channels.slack.channels`)
    - `requireMention`
    - 個別頻道的 `users` 允許清單

    實用指令：

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="私訊被忽略">
    檢查：

    - `channels.slack.dm.enabled`
    - `channels.slack.dm.policy`
    - Pairing 核准 / 允許清單項目

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket mode 無法連線">
    驗證 Slack 應用程式設定中的機器人 + 應用程式權杖以及 Socket Mode 是否已啟用。
  </Accordion>

  <Accordion title="HTTP 模式未收到事件">
    驗證：

    - signing secret
    - Webhook 路徑
    - Slack Request URL (Events + Interactivity + Slash Commands)
    - 每個 HTTP 帳戶使用唯一的 `webhookPath`

  </Accordion>

  <Accordion title="原生/斜線指令未觸發">
    確認您的意圖：

    - 原生指令模式 (`channels.slack.commands.native: true`) 並在 Slack 中註冊了相應的斜線指令
    - 或是單一斜線指令模式 (`channels.slack.slashCommand.enabled: true`)

    同時檢查 `commands.useAccessGroups` 以及頻道/使用者允許清單。

  </Accordion>
</AccordionGroup>

## 設定參考指標

主要參考：

- [設定參考 - Slack](/gateway/configuration-reference#slack)

高頻 Slack 欄位：

- 模式/驗證：`mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
- 私訊存取：`dm.enabled`, `dm.policy`, `dm.allowFrom`, `dm.groupEnabled`, `dm.groupChannels`
- 頻道存取：`groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
- 執行緒/歷史記錄：`replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- 傳遞：`textChunkLimit`, `chunkMode`, `mediaMaxMb`
- 維運/功能：`configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## 相關內容

- [Pairing](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [疑難排解](/channels/troubleshooting)
- [設定](/gateway/configuration)
- [Slash 指令](/tools/slash-commands)
