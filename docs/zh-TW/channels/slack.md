---
summary: "Slack 設定與運行行為 (Socket 模式 + HTTP 事件 API)"
read_when:
  - 設定 Slack 或偵錯 Slack Socket/HTTP 模式時
title: "Slack"
---

# Slack

狀態：透過 Slack 應用程式整合，DMs + 頻道已可正式投入生產。預設模式為 Socket 模式；也支援 HTTP 事件 API 模式。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    Slack 私訊預設為配對模式。
  </Card>
  <Card title="斜線指令" icon="terminal" href="/tools/slash-commands">
    原生指令行為與指令目錄。
  </Card>
  <Card title="頻道疑難排解" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷與修復指南。
  </Card>
</CardGroup>

## 快速設定

<Tabs>
  <Tab title="Socket 模式 (預設)">
    <Steps>
      <Step title="建立 Slack 應用程式與權杖">
        在 Slack 應用程式設定中：

        - 啟用 **Socket 模式**
        - 建立 **應用程式權杖** (`xapp-...`) 並授予 `connections:write` 權限
        - 安裝應用程式並複製 **機器人權杖** (`xoxb-...`)
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

        環境變數備援 (僅限預設帳戶)：

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="訂閱應用程式事件">
        訂閱機器人事件，包括：

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        同時為私訊啟用應用程式主頁的 **訊息分頁**。
      </Step>

      <Step title="啟動 Gateway">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="HTTP 事件 API 模式">
    <Steps>
      <Step title="設定 Slack 應用程式以使用 HTTP">

        - 將模式設定為 HTTP (`channels.slack.mode="http"`)
        - 複製 Slack **簽章密鑰**
        - 將事件訂閱 + 互動性 + 斜線指令請求 URL 設定為相同的 webhook 路徑 (預設為 `/slack/events`)

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

      <Step title="為多帳戶 HTTP 使用獨特的 webhook 路徑">
        支援每個帳戶的 HTTP 模式。

        為每個帳戶指定一個獨特的 `webhookPath`，以避免註冊衝突。
      </Step>
    </Steps>

  </Tab>
</Tabs>

## 權杖模型

- `botToken` + `appToken` 是 Socket 模式的必填項目。
- HTTP 模式需要 `botToken` + `signingSecret`。
- 設定權杖會覆寫環境變數備援。
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` 環境變數備援僅適用於預設帳戶。
- `userToken` (`xoxp-...`) 僅限設定 (無環境變數備援)，並預設為唯讀行為 (`userTokenReadOnly: true`)。

<Tip>
對於動作/目錄讀取，當已設定時可優先使用使用者權杖。對於寫入，機器人權杖仍是首選；使用者權杖寫入僅在 `userTokenReadOnly: false` 且機器人權杖不可用時才允許。
</Tip>

## 存取控制與路由

<Tabs>
  <Tab title="私訊政策">
    `channels.slack.dm.policy` 控制私訊存取：

    - `pairing` (預設)
    - `allowlist`
    - `open` (需要 `dm.allowFrom` 包含 `"*"`)
    - `disabled`

    私訊旗標：

    - `dm.enabled` (預設 true)
    - `dm.allowFrom`
    - `dm.groupEnabled` (群組私訊預設 false)
    - `dm.groupChannels` (可選的 MPIM 允許清單)

    在私訊中配對使用 `openclaw pairing approve slack <code>`。

  </Tab>

  <Tab title="頻道政策">
    `channels.slack.groupPolicy` 控制頻道處理：

    - `open`
    - `allowlist`
    - `disabled`

    頻道允許清單位於 `channels.slack.channels` 下。

    運行時注意事項：如果 `channels.slack` 完全缺失 (僅限環境變數設定)，且 `channels.defaults.groupPolicy` 未設定，則運行時會退回 `groupPolicy="open"` 並記錄警告。

    名稱/ID 解析：

    - 頻道允許清單條目和私訊允許清單條目在權杖存取允許時於啟動時解析
    - 未解析的條目會保留為已設定的狀態

  </Tab>

  <Tab title="提及與頻道使用者">
    頻道訊息預設由提及來管制。

    提及來源：

    - 明確的應用程式提及 (`< @botId>`)
    - 提及正規表達式模式 (`agents.list[].groupChat.mentionPatterns`，備援為 `messages.groupChat.mentionPatterns`)
    - 隱式回覆機器人的討論串行為

    每個頻道的控制項 (`channels.slack.channels.<id|name>`)：

    - `requireMention`
    - `users` (允許清單)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`

  </Tab>
</Tabs>

## 指令與斜線行為

- Slack 的原生指令自動模式為 **關閉** (`commands.native: "auto"` 不會啟用 Slack 原生指令)。
- 透過 `channels.slack.commands.native: true` (或全域 `commands.native: true`) 啟用原生 Slack 指令處理器。
- 啟用原生指令時，在 Slack 中註冊匹配的斜線指令 (`/<command>` 名稱)。
- 如果未啟用原生指令，您可以透過 `channels.slack.slashCommand` 執行單一已設定的斜線指令。

預設斜線指令設定：

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

斜線工作階段使用隔離的鍵：

- `agent:<agentId>:slack:slash:<userId>`

並且仍然根據目標對話工作階段 (`CommandTargetSessionKey`) 路由指令執行。

## 討論串、工作階段與回覆標籤

- 私訊路由為 `direct`；頻道為 `channel`；MPIMs 為 `group`。
- 透過預設的 `session.dmScope=main`，Slack 私訊會收納到智慧代理主工作階段。
- 頻道工作階段：`agent:<agentId>:slack:channel:<channelId>`。
- 在適用情況下，討論串回覆可以建立討論串工作階段後綴 (`:thread:<threadTs>`)。
- `channels.slack.thread.historyScope` 預設為 `thread`；`thread.inheritParent` 預設為 `false`。
- `channels.slack.thread.initialHistoryLimit` 控制新討論串工作階段啟動時擷取多少現有討論串訊息 (預設 `20`；設定 `0` 以禁用)。

回覆討論串控制項：

- `channels.slack.replyToMode`：`off|first|all` (預設 `off`)
- `channels.slack.replyToModeByChatType`：每個 `direct|group|channel`
- 直接對話的傳統備援：`channels.slack.dm.replyToMode`

支援手動回覆標籤：

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

## 媒體、分塊與遞送

<AccordionGroup>
  <Accordion title="傳入附件">
    Slack 檔案附件會從 Slack 託管的私人 URL (權杖驗證請求流程) 下載，並在擷取成功且大小限制允許時寫入媒體儲存區。

    運行時傳入大小上限預設為 `20MB`，除非由 `channels.slack.mediaMaxMb` 覆寫。

  </Accordion>

  <Accordion title="傳出文字與檔案">
    - 文字分塊使用 `channels.slack.textChunkLimit` (預設 4000)
    - `channels.slack.chunkMode="newline"` 啟用段落優先分割
    - 檔案傳送使用 Slack 上傳 API，並可包含討論串回覆 (`thread_ts`)
    - 傳出媒體上限在設定時遵循 `channels.slack.mediaMaxMb`；否則頻道傳送使用媒體管線中的 MIME 類型預設值
  </Accordion>

  <Accordion title="遞送目標">
    首選的明確目標：

    - `user:<id>` 用於私訊
    - `channel:<id>` 用於頻道

    當傳送給使用者目標時，Slack 私訊會透過 Slack 對話 API 開啟。

  </Accordion>
</AccordionGroup>

## 動作與閘門

Slack 動作由 `channels.slack.actions.*` 控制。

目前 Slack 工具中可用的動作群組：

| 群組       | 預設   |
| ---------- | ------ |
| 訊息       | 啟用   |
| 表情回應   | 啟用   |
| 釘選       | 啟用   |
| 成員資訊   | 啟用   |
| 表情符號清單 | 啟用   |

## 事件與操作行為

- 訊息編輯/刪除/討論串廣播會映射到系統事件。
- 表情回應新增/移除事件會映射到系統事件。
- 成員加入/離開、頻道建立/重新命名以及釘選新增/移除事件會映射到系統事件。
- 當啟用 `configWrites` 時，`channel_id_changed` 可以遷移頻道設定鍵。
- 頻道主題/用途元資料被視為不受信任的上下文，並可以注入到路由上下文中。

## 清單與範圍核對清單

<AccordionGroup>
  <Accordion title="Slack 應用程式清單範例">

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

  <Accordion title="可選的使用者權杖範圍 (讀取操作)">
    如果您設定 `channels.slack.userToken`，典型的讀取範圍為：

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
    - 每個頻道的 `使用者` 允許清單

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
    - 配對核准 / 允許清單條目

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket 模式無法連線">
    驗證機器人 + 應用程式權杖以及 Slack 應用程式設定中的 Socket 模式啟用狀態。
  </Accordion>

  <Accordion title="HTTP 模式未接收到事件">
    驗證：

    - 簽章密鑰
    - webhook 路徑
    - Slack 請求 URL (事件 + 互動性 + 斜線指令)
    - 每個 HTTP 帳戶獨特的 `webhookPath`

  </Accordion>

  <Accordion title="原生/斜線指令未觸發">
    確認您是否意圖為：

    - 原生指令模式 (`channels.slack.commands.native: true`) 並在 Slack 中註冊了匹配的斜線指令
    - 或單一斜線指令模式 (`channels.slack.slashCommand.enabled: true`)

    同時檢查 `commands.useAccessGroups` 和頻道/使用者允許清單。

  </Accordion>
</AccordionGroup>

## 設定參考指標

主要參考：

- [設定參考 - Slack](/gateway/configuration-reference#slack)

高關聯性 Slack 欄位：

- 模式/驗證：`mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
- 私訊存取：`dm.enabled`, `dm.policy`, `dm.allowFrom`, `dm.groupEnabled`, `dm.groupChannels`
- 頻道存取：`groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
- 討論串/歷史：`replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- 遞送：`textChunkLimit`, `chunkMode`, `mediaMaxMb`
- 操作/功能：`configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## 相關

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [疑難排解](/channels/troubleshooting)
- [設定](/gateway/configuration)
- [斜線指令](/tools/slash-commands)
