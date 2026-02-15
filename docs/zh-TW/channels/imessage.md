---
summary: "透過 imsg (JSON-RPC 經由 stdio) 提供舊版 iMessage 支援。新的設定建議使用 BlueBubbles。"
read_when:
  - 設定 iMessage 支援
  - 偵錯 iMessage 傳送/接收
title: "iMessage"
---

# iMessage (舊版：imsg)

<Warning>
對於新的 iMessage 部署，請使用 <a href="/channels/bluebubbles">BlueBubbles</a>。

`imsg` 整合已屬舊版 (legacy)，可能會在未來的版本中移除。
</Warning>

狀態：舊版外部 CLI 整合。Gateway 會啟動 `imsg rpc` 並透過 stdio 上的 JSON-RPC 進行通訊（無需獨立的守護行程/連接埠）。

<CardGroup cols={3}>
  <Card title="BlueBubbles (建議)" icon="message-circle" href="/channels/bluebubbles">
    新設定首選的 iMessage 路徑。
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    iMessage 私訊預設為 pairing 模式。
  </Card>
  <Card title="設定參考" icon="settings" href="/gateway/configuration-reference#imessage">
    完整的 iMessage 欄位參考。
  </Card>
</CardGroup>

## 快速開始

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

      <Step title="核准首次私訊 pairing (預設 dmPolicy)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        pairing 請求將在 1 小時後過期。
      </Step>
    </Steps>

  </Tab>

  <Tab title="透過 SSH 連接遠端 Mac">
    OpenClaw 僅需要相容 stdio 的 `cliPath`，因此您可以將 `cliPath` 指向一個包裝指令碼 (wrapper script)，該指令碼透過 SSH 連接到遠端 Mac 並執行 `imsg`。

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

    如果未設定 `remoteHost`，OpenClaw 會嘗試透過解析 SSH 包裝指令碼來自動偵測。

  </Tab>
</Tabs>

## 需求與權限 (macOS)

- 必須在執行 `imsg` 的 Mac 上登入 Messages。
- 執行 OpenClaw/`imsg` 的程序內容需要「全磁碟存取權限」（以存取 Messages 資料庫）。
- 需要「自動化」權限才能透過 Messages.app 傳送訊息。

<Tip>
權限是按程序內容授予的。如果 Gateway 以無介面模式執行 (LaunchAgent/SSH)，請在相同的內容中執行一次性互動式指令以觸發提示：

```bash
imsg chats --limit 1
# 或
imsg send <handle> "test"
```

</Tip>

## 存取控制與路由

<Tabs>
  <Tab title="私訊原則 (DM policy)">
    `channels.imessage.dmPolicy` 控制私訊：

    - `pairing` (預設)
    - `allowlist`
    - `open` (需要 `allowFrom` 包含 `"*"` )
    - `disabled`

    允許清單欄位：`channels.imessage.allowFrom`。

    允許清單項目可以是帳號 (handles) 或聊天目標 (`chat_id:*`, `chat_guid:*`, `chat_identifier:*`)。

  </Tab>

  <Tab title="群組原則 + 提及">
    `channels.imessage.groupPolicy` 控制群組處理：

    - `allowlist` (有設定時的預設值)
    - `open`
    - `disabled`

    群組傳送者允許清單：`channels.imessage.groupAllowFrom`。

    執行時回退：如果未設定 `groupAllowFrom`，iMessage 群組傳送者檢查將在可用時回退到 `allowFrom`。

    群組的提及過濾 (Mention gating)：

    - iMessage 沒有原生的提及中繼資料
    - 提及偵測使用正則表達式模式 (`agents.list[].groupChat.mentionPatterns`，回退至 `messages.groupChat.mentionPatterns`)
    - 若未設定模式，則無法強制執行提及過濾

    來自授權傳送者的控制指令可以繞過群組中的提及過濾。

  </Tab>

  <Tab title="工作階段與確定性回覆">
    - 私訊使用直接路由；群組使用群組路由。
    - 在使用預設 `session.dmScope=main` 的情況下，iMessage 私訊會併入智慧代理的主要工作階段。
    - 群組工作階段是隔離的 (`agent:<agentId>:imessage:group:<chat_id>`)。
    - 回覆會使用原始頻道/目標中繼資料路由回 iMessage。

    類群組執行緒行為：

    某些多參與者的 iMessage 執行緒在到達時可能標示為 `is_group=false`。
    如果該 `chat_id` 在 `channels.imessage.groups` 下有明確設定，OpenClaw 會將其視為群組流量（進行群組過濾與群組工作階段隔離）。

  </Tab>
</Tabs>

## 部署模式

<AccordionGroup>
  <Accordion title="專用的 Bot macOS 使用者（獨立的 iMessage 身分）">
    使用專用的 Apple ID 和 macOS 使用者，讓 Bot 流量與您的個人 Messages 設定檔隔離。

    典型流程：

    1. 建立/登入一個專用的 macOS 使用者。
    2. 在該使用者中以 Bot Apple ID 登入 Messages。
    3. 在該使用者中安裝 `imsg`。
    4. 建立 SSH 包裝指令碼，讓 OpenClaw 可以在該使用者內容中執行 `imsg`。
    5. 將 `channels.imessage.accounts.<id>.cliPath` 和 `.dbPath` 指向該使用者設定檔。

    首次執行可能需要在該 Bot 使用者工作階段中進行 GUI 核准（自動化 + 全磁碟存取權限）。

  </Accordion>

  <Accordion title="透過 Tailscale 連接遠端 Mac (範例)">
    常見拓撲：

    - Gateway 執行於 Linux/虛擬機器
    - iMessage + `imsg` 執行於您 Tailscale 網路中的 Mac
    - `cliPath` 包裝指令碼使用 SSH 執行 `imsg`
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

    使用 SSH 金鑰，使 SSH 和 SCP 均為非互動式。

  </Accordion>

  <Accordion title="多帳號模式">
    iMessage 支援在 `channels.imessage.accounts` 下進行個別帳號設定。

    每個帳號都可以覆寫 `cliPath`、`dbPath`、`allowFrom`、`groupPolicy`、`mediaMaxMb` 和歷史記錄設定等欄位。

  </Accordion>
</AccordionGroup>

## 媒體、分段與傳遞目標

<AccordionGroup>
  <Accordion title="附件與媒體">
    - 傳入附件攝取是選用的：`channels.imessage.includeAttachments`
    - 當設定了 `remoteHost` 時，可以透過 SCP 擷取遠端附件路徑
    - 外傳媒體大小使用 `channels.imessage.mediaMaxMb`（預設 16 MB）
  </Accordion>

  <Accordion title="外傳分段">
    - 文字分段限制：`channels.imessage.textChunkLimit`（預設 4000）
    - 分段模式：`channels.imessage.chunkMode`
      - `length` (預設)
      - `newline` (段落優先分割)
  </Accordion>

  <Accordion title="定址格式">
    偏好的明確目標：

    - `chat_id:123` (建議用於穩定路由)
    - `chat_guid:...`
    - `chat_identifier:...`

    也支援帳號 (Handle) 目標：

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user @example.com`

```bash
imsg chats --limit 20
```

  </Accordion>
</AccordionGroup>

## 設定寫入

iMessage 預設允許由頻道發起的設定寫入（用於當 `commands.config: true` 時的 `/config set|unset`）。

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
    驗證執行檔與 RPC 支援：

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
    - pairing 核准 (`openclaw pairing list imessage`)

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
    - 在執行 Messages 的 Mac 上的遠端路徑可讀性

  </Accordion>

  <Accordion title="遺漏了 macOS 權限提示">
    在相同的使用者/工作階段內容中，於互動式 GUI 終端機中重新執行並核准提示：

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    確認已為執行 OpenClaw/`imsg` 的程序內容授予「全磁碟存取權限」+「自動化」。

  </Accordion>
</AccordionGroup>

## 設定參考指標

- [設定參考 - iMessage](/gateway/configuration-reference#imessage)
- [Gateway 設定](/gateway/configuration)
- [Pairing](/channels/pairing)
- [BlueBubbles](/channels/bluebubbles)
