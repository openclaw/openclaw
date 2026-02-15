---
summary: "透過 imsg (JSON-RPC over stdio) 支援舊版 iMessage。新設定應使用 BlueBubbles。"
read_when:
  - 設定 iMessage 支援
  - 偵錯 iMessage 傳送/接收問題
title: "iMessage"
---

# iMessage (舊版: imsg)

<Warning>
對於新的 iMessage 部署，請使用 <a href="/channels/bluebubbles">BlueBubbles</a>。

`imsg` 整合是舊版功能，可能在未來的版本中移除。
</Warning>

狀態：舊版外部 CLI 整合。Gateway 啟動 `imsg rpc` 並透過 stdio 上的 JSON-RPC 進行通訊（沒有獨立的守護程式/埠）。

<CardGroup cols={3}>
  <Card title="BlueBubbles (建議)" icon="message-circle" href="/channels/bluebubbles">
    新設定的首選 iMessage 路徑。
  </Card>
  <Card title="配對" icon="link" href="/channels/pairing">
    iMessage 私訊預設為配對模式。
  </Card>
  <Card title="設定參考" icon="settings" href="/gateway/configuration-reference#imessage">
    完整的 iMessage 欄位參考。
  </Card>
</CardGroup>

## 快速設定

<Tabs>
  <Tab title="本機 Mac (快速路徑)">
    <Steps>
      <Step title="安裝並驗證 imsg">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="設定 OpenClaw">

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

      </Step>

      <Step title="啟動 Gateway">

```bash
openclaw gateway
```

      </Step>

      <Step title="核准首次私訊配對 (預設 dmPolicy)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        配對請求於 1 小時後過期。
      </Step>
    </Steps>

  </Tab>

  <Tab title="透過 SSH 的遠端 Mac">
    OpenClaw 只需要一個與 stdio 相容的 `cliPath`，因此您可以將 `cliPath` 指向一個包裝器腳本，該腳本透過 SSH 連線到遠端 Mac 並執行 `imsg`。

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$ @"
```

    啟用附件時的建議設定：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user @gateway-host", // 用於 SCP 附件擷取
      includeAttachments: true,
    },
  },
}
```

    如果未設定 `remoteHost`，OpenClaw 會嘗試透過解析 SSH 包裝器腳本來自動偵測。

  </Tab>
</Tabs>

## 要求和權限 (macOS)

- 訊息必須在執行 `imsg` 的 Mac 上登入。
- 執行 OpenClaw/`imsg` 的程序上下文需要完全磁碟存取權限（訊息資料庫存取）。
- 透過 Messages.app 傳送訊息需要自動化權限。

<Tip>
權限是按程序上下文授予的。如果 Gateway 以無頭模式（LaunchAgent/SSH）運行，請在同一上下文中運行一次性互動命令以觸發提示：

```bash
imsg chats --limit 1
# 或
imsg send <handle> "test"
```

</Tip>

## 存取控制和路由

<Tabs>
  <Tab title="私訊政策">
    `channels.imessage.dmPolicy` 控制直接訊息：

    - `pairing` (預設)
    - `allowlist` (允許清單)
    - `open` (需要 `allowFrom` 包含 `"*"` )
    - `disabled` (已停用)

    允許清單欄位：`channels.imessage.allowFrom`。

    允許清單項目可以是處理程序或聊天目標 (`chat_id:*`、`chat_guid:*`、`chat_identifier:*`)。

  </Tab>

  <Tab title="群組政策 + 提及">
    `channels.imessage.groupPolicy` 控制群組處理：

    - `allowlist` (設定時的預設值)
    - `open`
    - `disabled`

    群組傳送者允許清單：`channels.imessage.groupAllowFrom`。

    執行時回退：如果未設定 `groupAllowFrom`，iMessage 群組傳送者檢查會回退到 `allowFrom`（如果可用）。

    群組提及過濾：

    - iMessage 沒有原生的提及中繼資料
    - 提及偵測使用正規表示式模式 (`agents.list[].groupChat.mentionPatterns`，回退 `messages.groupChat.mentionPatterns`)
    - 未設定模式時，無法強制執行提及過濾

    來自授權傳送者的控制命令可以繞過群組中的提及過濾。

  </Tab>

  <Tab title="工作階段與確定性回覆">
    - 私訊使用直接路由；群組使用群組路由。
    - 在預設 `session.dmScope=main` 的情況下，iMessage 私訊會合併到智慧代理主要工作階段。
    - 群組工作階段是隔離的 (`agent:<agentId>:imessage:group:<chat_id>`)。
    - 回覆透過原始頻道/目標中繼資料路由回 iMessage。

    類似群組的執行緒行為：

    一些多參與者的 iMessage 執行緒可能會以 `is_group=false` 的方式到達。
    如果該 `chat_id` 在 `channels.imessage.groups` 下明確設定，OpenClaw 會將其視為群組流量（群組過濾 + 群組工作階段隔離）。

  </Tab>
</Tabs>

## 部署模式

<AccordionGroup>
  <Accordion title="專用機器人 macOS 使用者 (獨立的 iMessage 身份)">
    使用專用的 Apple ID 和 macOS 使用者，以便機器人流量與您的個人訊息設定檔隔離。

    典型流程：

    1. 建立/登入專用的 macOS 使用者。
    2. 在該使用者中，使用機器人 Apple ID 登入訊息。
    3. 在該使用者中安裝 `imsg`。
    4. 建立 SSH 包裝器，以便 OpenClaw 可以在該使用者上下文中運行 `imsg`。
    5. 將 `channels.imessage.accounts.<id>.cliPath` 和 `.dbPath` 指向該使用者設定檔。

    首次運行可能需要在該機器人使用者工作階段中進行 GUI 核准（自動化 + 完全磁碟存取）。

  </Accordion>

  <Accordion title="透過 Tailscale 的遠端 Mac (範例)">
    常見拓撲：

    - Gateway 在 Linux/VM 上運行
    - iMessage + `imsg` 在您的 tailnet 中的 Mac 上運行
    - `cliPath` 包裝器使用 SSH 運行 `imsg`
    - `remoteHost` 啟用 SCP 附件擷取

    範例：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot @mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

```bash
#!/usr/bin/env bash
exec ssh -T bot @mac-mini.tailnet-1234.ts.net imsg "$ @"
```

    使用 SSH 金鑰，以便 SSH 和 SCP 都是非互動式的。

  </Accordion>

  <Accordion title="多帳號模式">
    iMessage 支援 `channels.imessage.accounts` 下的每個帳號設定。

    每個帳號都可以覆寫諸如 `cliPath`、`dbPath`、`allowFrom`、`groupPolicy`、`mediaMaxMb` 和歷史記錄設定等欄位。

  </Accordion>
</AccordionGroup>

## 設定寫入

iMessage 預設允許頻道啟動的設定寫入（對於 `commands.config: true` 時的 `/config set|unset`）。

停用：

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

## 疑難排解

<AccordionGroup>
  <Accordion title="找不到 imsg 或不支援 RPC">
    驗證二進位檔案和 RPC 支援：

```bash
imsg rpc --help
openclaw channels status --probe
```

    如果探測報告 RPC 不支援，請更新 `imsg`。

  </Accordion>

  <Accordion title="私訊被忽略">
    檢查：

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - 配對核准 (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="群組訊息被忽略">
    檢查：

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` 允許清單行為
    - 提及模式設定 (`agents.list[].groupChat.mentionPatterns`)

  </Accordion>

  <Accordion title="遠端附件失敗">
    檢查：

    - `channels.imessage.remoteHost`
    - 來自 Gateway 主機的 SSH/SCP 金鑰驗證
    - Mac 上執行訊息的遠端路徑可讀性

  </Accordion>

  <Accordion title="macOS 權限提示被忽略">
    在同一使用者/工作階段上下文中，在互動式 GUI 終端機中重新運行並核准提示：

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    確認已為運行 OpenClaw/`imsg` 的程序上下文授予完全磁碟存取權限 + 自動化權限。

  </Accordion>
</AccordionGroup>

## 設定參考指標

- [設定參考 - iMessage](/gateway/configuration-reference#imessage)
- [Gateway 設定](/gateway/configuration)
- [配對](/channels/pairing)
- [BlueBubbles](/channels/bluebubbles)
