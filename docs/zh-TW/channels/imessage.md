---
summary: >-
  Legacy iMessage support via imsg (JSON-RPC over stdio). New setups should use
  BlueBubbles.
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
title: iMessage
---

# iMessage (legacy: imsg)

<Warning>
對於新的 iMessage 部署，請使用 <a href="/channels/bluebubbles">BlueBubbles</a>。

該 `imsg` 整合為舊版，可能會在未來的版本中移除。

狀態：舊版外部 CLI 整合。網關產生 `imsg rpc` 並透過 JSON-RPC 在標準輸入輸出上進行通信（不需要單獨的守護進程/端口）。

<CardGroup cols={3}>
  <Card title="BlueBubbles (推薦)" icon="message-circle" href="/channels/bluebubbles">
    新設置的首選 iMessage 路徑。
  </Card>
  <Card title="配對" icon="link" href="/channels/pairing">
    iMessage 直接消息預設為配對模式。
  </Card>
  <Card title="設定參考" icon="settings" href="/gateway/configuration-reference#imessage">
    完整的 iMessage 欄位參考。
  </Card>
</CardGroup>

## 快速設定

<Tabs>
  <Tab title="本地 Mac（快速路徑）">
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

<Step title="啟動閘道">

```bash
openclaw gateway
```

</Step>

<Step title="批准第一個 DM 配對（預設 dmPolicy）">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

配對請求在 1 小時後過期。
</Step>
</Steps>

</Tab>

<Tab title="透過 SSH 遠端連接 Mac">
    OpenClaw 只需要一個與 stdio 兼容的 `cliPath`，因此你可以將 `cliPath` 指向一個包裝腳本，該腳本透過 SSH 連接到遠端 Mac 並執行 `imsg`。

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

啟用附件時的建議設定：

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@gateway-host", // used for SCP attachment fetches
      includeAttachments: true,
      // Optional: override allowed attachment roots.
      // Defaults include /Users/*/Library/Messages/Attachments
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

如果 `remoteHost` 沒有設定，OpenClaw 會透過解析 SSH 包裝腳本來嘗試自動偵測它。  
`remoteHost` 必須是 `host` 或 `user@host`（不可以有空格或 SSH 選項）。  
OpenClaw 對 SCP 使用嚴格的主機金鑰檢查，因此中繼主機金鑰必須已經存在於 `~/.ssh/known_hosts` 中。  
附件路徑會根據允許的根目錄進行驗證 (`attachmentRoots` / `remoteAttachmentRoots`).

</Tab>
</Tabs>

## 要求和權限 (macOS)

- 訊息必須在執行 `imsg` 的 Mac 上簽名。
- 進行 OpenClaw/`imsg` 的過程上下文需要完全磁碟存取權（Messages DB 存取）。
- 需要自動化權限才能通過 Messages.app 發送訊息。

<Tip>
權限是根據每個進程上下文授予的。如果網關以無頭模式執行（LaunchAgent/SSH），請在相同的上下文中執行一次互動命令以觸發提示：

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

</Tip>

## 存取控制與路由

<Tabs>
  <Tab title="DM 政策">
    `channels.imessage.dmPolicy` 控制直接訊息：

- `pairing` (預設)
  - `allowlist`
  - `open` (需要 `allowFrom` 來包含 `"*"`)
  - `disabled`

Allowlist 欄位: `channels.imessage.allowFrom`。

允許清單條目可以是處理程序或聊天目標 (`chat_id:*`, `chat_guid:*`, `chat_identifier:*`)。

</Tab>

<Tab title="群組政策 + 提及">
    `channels.imessage.groupPolicy` 控制群組處理：

- `allowlist` (預設設定時)
  - `open`
  - `disabled`

群組發送者允許清單：`channels.imessage.groupAllowFrom`。

Runtime fallback: 如果 `groupAllowFrom` 未設定，iMessage 群組發送者檢查將回退到 `allowFrom`（如果可用）。  
 Runtime note: 如果 `channels.imessage` 完全缺失，執行時將回退到 `groupPolicy="allowlist"` 並記錄警告（即使 `channels.defaults.groupPolicy` 已設定）。

[[BLOCK_1]]  
提到群組的閘道：  
[[BLOCK_2]]

- iMessage 沒有原生的提及元數據
  - 提及檢測使用正則表達式模式 (`agents.list[].groupChat.mentionPatterns`，後備 `messages.groupChat.mentionPatterns`)
  - 如果沒有設定模式，則無法強制執行提及閘道

來自授權發送者的控制命令可以繞過群組中的提及限制。

</Tab>

<Tab title="會話與確定性回覆">
    - 直接訊息使用直接路由；群組使用群組路由。
    - 使用預設 `session.dmScope=main`，iMessage 直接訊息會合併到代理的主要會話中。
    - 群組會話是隔離的 (`agent:<agentId>:imessage:group:<chat_id>`)。
    - 回覆會透過來源通道/目標元數據路由回 iMessage。

[[BLOCK_1]]  
群組式線程行為：  
[[BLOCK_1]]

某些多參與者的 iMessage 討論串可能會帶有 `is_group=false`。如果該 `chat_id` 在 `channels.imessage.groups` 下被明確設定，OpenClaw 將其視為群組流量（群組閘道 + 群組會話隔離）。

</Tab>
</Tabs>

## 部署模式

<AccordionGroup>
  <Accordion title="專用的 macOS 使用者 (獨立的 iMessage 身分)">
    使用專用的 Apple ID 和 macOS 使用者，以便將機器人流量與您的個人訊息檔案隔離。

典型流程：

1. 創建/登入一個專用的 macOS 使用者。
2. 使用該使用者的 bot Apple ID 登入 Messages。
3. 在該使用者中安裝 `imsg`。
4. 創建 SSH 包裝器，以便 OpenClaw 可以在該使用者的上下文中執行 `imsg`。
5. 將 `channels.imessage.accounts.<id>.cliPath` 和 `.dbPath` 指向該使用者的個人資料。

第一次執行可能需要在該機器人用戶會話中進行 GUI 授權（自動化 + 完整磁碟存取）。

</Accordion>

<Accordion title="透過 Tailscale 遠端連接 Mac（範例）">
    常見拓撲：

- gateway 在 Linux/VM 上執行
  - iMessage + `imsg` 在你的 tailnet 中的 Mac 上執行
  - `cliPath` 包裝器使用 SSH 來執行 `imsg`
  - `remoteHost` 使 SCP 附件獲取成為可能

[[BLOCK_1]]

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

使用 SSH 金鑰，使得 SSH 和 SCP 都能無需互動。  
首先確保主機金鑰是受信任的（例如 `ssh bot@mac-mini.tailnet-1234.ts.net`），以便 `known_hosts` 被填充。

</Accordion>

<Accordion title="多帳號模式">
    iMessage 支援在 `channels.imessage.accounts` 下的每個帳號設定。

每個帳戶可以覆寫字段，例如 `cliPath`、`dbPath`、`allowFrom`、`groupPolicy`、`mediaMaxMb`、歷史設置和附件根目錄允許清單。

</Accordion>
</AccordionGroup>

## 媒體、分塊和交付目標

<AccordionGroup>
  <Accordion title="附件和媒體">
    - 輸入附件的攝取是可選的: `channels.imessage.includeAttachments`
    - 當 `remoteHost` 被設定時，可以透過 SCP 獲取遠端附件路徑
    - 附件路徑必須符合允許的根目錄：
      - `channels.imessage.attachmentRoots` (本地)
      - `channels.imessage.remoteAttachmentRoots` (遠端 SCP 模式)
      - 預設根模式: `/Users/*/Library/Messages/Attachments`
    - SCP 使用嚴格的主機金鑰檢查 (`StrictHostKeyChecking=yes`)
    - 輸出媒體大小使用 `channels.imessage.mediaMaxMb` (預設 16 MB)
  </Accordion>

<Accordion title="外部分塊">
    - 文字塊限制: `channels.imessage.textChunkLimit` (預設 4000)
    - 分塊模式: `channels.imessage.chunkMode`
      - `length` (預設)
      - `newline` (段落優先分割)
  </Accordion>

<Accordion title="地址格式">
    首選明確目標：

- `chat_id:123` （建議用於穩定路由）
  - `chat_guid:...`
  - `chat_identifier:...`

[[BLOCK_1]] 也支援處理目標：[[BLOCK_1]]

- `imessage:+1555...`
  - `sms:+1555...`
  - `user@example.com`

```bash
imsg chats --limit 20
```

</Accordion>
</AccordionGroup>

## Config writes

iMessage 預設允許通道啟動的設定寫入 (對於 `/config set|unset` 當 `commands.config: true` 時)。

[[BLOCK_1]]

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

## 故障排除

<AccordionGroup>
  <Accordion title="imsg 未找到或不支援 RPC">
    驗證二進位檔和 RPC 支援：

```bash
imsg rpc --help
openclaw channels status --probe
```

如果探針報告 RPC 不受支援，請更新 `imsg`。

</Accordion>

<Accordion title="DMs 被忽略">
    檢查：

- `channels.imessage.dmPolicy`
  - `channels.imessage.allowFrom`
  - 配對批准 (`openclaw pairing list imessage`)

</Accordion>

<Accordion title="群組訊息會被忽略">
    檢查：

- `channels.imessage.groupPolicy`
  - `channels.imessage.groupAllowFrom`
  - `channels.imessage.groups` 允許清單行為
  - 提及模式設定 (`agents.list[].groupChat.mentionPatterns`)

</Accordion>

<Accordion title="遠端附件失敗">
    檢查：

- `channels.imessage.remoteHost`
  - `channels.imessage.remoteAttachmentRoots`
  - 從閘道主機的 SSH/SCP 金鑰驗證
  - 主機金鑰存在於 `~/.ssh/known_hosts` 的閘道主機上
  - 在執行 Messages 的 Mac 上的遠端路徑可讀性

</Accordion>

<Accordion title="macOS 權限提示被忽略">
    在相同的使用者/會話上下文中，在互動式 GUI 終端機中重新執行並批准提示：

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

確認已授予 OpenClaw/`imsg` 執行的過程上下文的完整磁碟存取權限 + 自動化權限。

</Accordion>
</AccordionGroup>

## 設定參考指標

- [設定參考 - iMessage](/gateway/configuration-reference#imessage)
- [閘道設定](/gateway/configuration)
- [配對](/channels/pairing)
- [BlueBubbles](/channels/bluebubbles)
