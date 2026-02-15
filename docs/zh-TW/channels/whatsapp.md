---
summary: "WhatsApp 頻道支援、存取控制、傳輸行為及操作"
read_when:
  - 處理 WhatsApp/web 頻道行為或收件匣路由時
title: "WhatsApp"
---

# WhatsApp (Web 頻道)

狀態：已可投入生產 (透過 WhatsApp Web (Baileys))。Gateway 擁有已連結的工作階段。

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    預設私訊策略是針對未知寄件者進行配對。
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷與修復手冊。
  </Card>
  <Card title="Gateway configuration" icon="settings" href="/gateway/configuration">
    完整的頻道設定模式與範例。
  </Card>
</CardGroup>

## 快速設定

<Steps>
  <Step title="Configure WhatsApp access policy">

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

  </Step>

  <Step title="Link WhatsApp (QR)">

```bash
openclaw channels login --channel whatsapp
```

    針對特定帳戶：

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="Start the gateway">

```bash
openclaw gateway
```

  </Step>

  <Step title="Approve first pairing request (if using pairing mode)">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    配對請求在 1 小時後失效。每個頻道最多 3 個待處理請求。

  </Step>
</Steps>

<Note>
OpenClaw 建議盡可能在獨立的號碼上執行 WhatsApp。（頻道中繼資料和新手導覽流程已針對此設定進行優化，但也支援個人號碼設定。）
</Note>

## 部署模式

<AccordionGroup>
  <Accordion title="Dedicated number (recommended)">
    這是最簡潔的操作模式：

    - 獨立的 OpenClaw WhatsApp 身份
    - 更清晰的私訊允許列表與路由界限
    - 較低的自聊混淆機率

    最小策略模式：

    ```json5
    {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Personal-number fallback">
    新手導覽支援個人號碼模式，並寫入對自聊友善的基準設定：

    - `dmPolicy: "allowlist"`
    - `allowFrom` 包含您的個人號碼
    - `selfChatMode: true`

    在執行期間，自聊保護機制會依據連結的自用號碼和 `allowFrom` 啟用。

  </Accordion>

  <Accordion title="WhatsApp Web-only channel scope">
    在目前的 OpenClaw 頻道架構中，訊息平台頻道是基於 WhatsApp Web (Baileys)。

    內建聊天頻道註冊表中沒有獨立的 Twilio WhatsApp 訊息頻道。

  </Accordion>
</AccordionGroup>

## 執行時模型

- Gateway 擁有 WhatsApp Socket 與重連迴圈。
- 傳送訊息需要目標帳戶具有活躍的 WhatsApp 監聽器。
- 狀態與廣播聊天會被忽略 (` @status`、` @broadcast`)。
- 直接聊天使用私訊工作階段規則 (`session.dmScope`；預設 `main` 將私訊折疊至智慧代理主要工作階段)。
- 群組工作階段是隔離的 (`agent:<agentId>:whatsapp:group:<jid>`)。

## 存取控制與啟用

<Tabs>
  <Tab title="DM policy">
    `channels.whatsapp.dmPolicy` 控制直接聊天存取：

    - `pairing` (預設)
    - `allowlist`
    - `open` (需要 `allowFrom` 包含 `"*"`)
    - `disabled`

    `allowFrom` 接受 E.164 格式的號碼 (內部會進行正規化)。

    執行時行為細節：

    - 配對會保存在頻道允許列表儲存區中，並與設定的 `allowFrom` 合併
    - 如果沒有設定允許列表，預設會允許已連結的自用號碼
    - 傳送的 `fromMe` 私訊絕不會自動配對

  </Tab>

  <Tab title="Group policy + allowlists">
    群組存取有兩個層級：

    1. **群組成員資格允許列表** (`channels.whatsapp.groups`)
       - 如果省略 `groups`，所有群組都符合資格
       - 如果 `groups` 存在，它將作為群組允許列表 (`"*"` 允許)

    2. **群組寄件者策略** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open`：寄件者允許列表被繞過
       - `allowlist`：寄件者必須符合 `groupAllowFrom` (或 `*`)
       - `disabled`：封鎖所有群組入站

    寄件者允許列表備用方案：

    - 如果 `groupAllowFrom` 未設定，執行時會在可用時回退到 `allowFrom`

    注意：如果完全沒有 `channels.whatsapp` 區塊，執行時群組策略的備用方案實際上是 `open`。

  </Tab>

  <Tab title="Mentions + /activation">
    群組回覆預設需要提及。

    提及偵測包括：

    - 明確的 WhatsApp 對機器人身份的提及
    - 設定的提及正規表達式模式 (`agents.list[].groupChat.mentionPatterns`，備用 `messages.groupChat.mentionPatterns`)
    - 隱式回覆機器人偵測 (回覆寄件者符合機器人身份)

    工作階段層級啟用指令：

    - `/activation mention`
    - `/activation always`

    `activation` 更新工作階段狀態 (而非全域設定)。它受擁有者控制。

  </Tab>
</Tabs>

## 個人號碼與自聊行為

當已連結的自用號碼也存在於 `allowFrom` 中時，WhatsApp 自聊保護措施會啟用：

- 自聊回合跳過已讀回條
- 忽略否則會提及自己的提及-JID 自動觸發行為
- 如果 `messages.responsePrefix` 未設定，自聊回覆預設為 `[{identity.name}]` 或 `[openclaw]`

## 訊息正規化與上下文

<AccordionGroup>
  <Accordion title="Inbound envelope + reply context">
    傳入的 WhatsApp 訊息會被包裹在共享的入站信封中。

    如果存在引用的回覆，上下文會以這種形式附加：

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    回覆中繼資料欄位在可用時也會被填充 (`ReplyToId`、`ReplyToBody`、`ReplyToSender`、寄件者 JID/E.164)。

  </Accordion>

  <Accordion title="Media placeholders and location/contact extraction">
    僅包含媒體的入站訊息會使用以下佔位符進行正規化：

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    位置和聯絡人負載在路由前會被正規化為文字上下文。

  </Accordion>

  <Accordion title="Pending group history injection">
    對於群組，未處理的訊息可以被緩衝，並在機器人最終被觸發時作為上下文注入。

    - 預設限制：`50`
    - 設定：`channels.whatsapp.historyLimit`
    - 備用：`messages.groupChat.historyLimit`
    - `0` 停用

    注入標記：

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="Read receipts">
    對於接受的入站 WhatsApp 訊息，預設啟用已讀回條。

    全域停用：

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    每個帳戶覆寫：

    ```json5
    {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              sendReadReceipts: false,
            },
          },
        },
      },
    }
    ```

    即使全域啟用，自聊回合也會跳過已讀回條。

  </Accordion>
</AccordionGroup>

## 傳輸、分塊與媒體

<AccordionGroup>
  <Accordion title="Text chunking">
    - 預設分塊限制：`channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` 模式優先使用段落邊界 (空行)，然後回退到長度安全的分塊
  </Accordion>

  <Accordion title="Outbound media behavior">
    - 支援圖片、影片、音訊 (PTT 語音訊息) 和文件負載
    - `audio/ogg` 會重寫為 `audio/ogg; codecs=opus` 以提供語音訊息相容性
    - 透過影片傳送時的 `gifPlayback: true` 支援動畫 GIF 播放
    - 傳送多媒體回覆負載時，字幕會應用於第一個媒體項目
    - 媒體來源可以是 HTTP(S)、`file://` 或本機路徑
  </Accordion>

  <Accordion title="Media size limits and fallback behavior">
    - 入站媒體儲存上限：`channels.whatsapp.mediaMaxMb` (預設 `50`)
    - 自動回覆的傳送媒體上限：`agents.defaults.mediaMaxMb` (預設 `5MB`)
    - 圖片會自動優化 (調整大小/品質掃描) 以符合限制
    - 媒體傳送失敗時，第一個項目會以文字警告代替，而非默默地捨棄回應
  </Accordion>
</AccordionGroup>

## 確認反應

WhatsApp 支援透過 `channels.whatsapp.ackReaction` 對入站接收立即發送確認反應。

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions", // always | mentions | never
      },
    },
  },
}
```

行為注意事項：

- 在入站訊息被接受後立即傳送 (回覆前)
- 失敗會被記錄下來，但不會阻礙正常的回覆傳送
- 群組模式 `mentions` 會對提及觸發的回合做出反應；群組啟用 `always` 作為此檢查的繞過
- WhatsApp 使用 `channels.whatsapp.ackReaction` (此處不使用舊版 `messages.ackReaction`)

## 多帳戶與憑證

<AccordionGroup>
  <Accordion title="Account selection and defaults">
    - 帳戶 ID 來自 `channels.whatsapp.accounts`
    - 預設帳戶選擇：如果存在 `default`，否則為第一個設定的帳戶 ID (已排序)
    - 帳戶 ID 在內部會進行正規化以供查詢
  </Accordion>

  <Accordion title="Credential paths and legacy compatibility">
    - 目前驗證路徑：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - 備份檔案：`creds.json.bak`
    - 舊版預設驗證在 `~/.openclaw/credentials/` 中仍可識別/遷移以用於預設帳戶流程
  </Accordion>

  <Accordion title="Logout behavior">
    `openclaw channels logout --channel whatsapp [--account <id>]` 清除該帳戶的 WhatsApp 驗證狀態。

    在舊版驗證目錄中，`oauth.json` 會保留，而 Baileys 驗證檔案會被移除。

  </Accordion>
</AccordionGroup>

## 工具、動作與設定寫入

- 智慧代理工具支援包括 WhatsApp 反應動作 (`react`)。
- 動作閘門：
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- 頻道發起的設定寫入預設為啟用 (可透過 `channels.whatsapp.configWrites=false` 停用)。

## 疑難排解

<AccordionGroup>
  <Accordion title="Not linked (QR required)">
    症狀：頻道狀態報告未連結。

    解決方法：

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="Linked but disconnected / reconnect loop">
    症狀：連結帳戶重複中斷連線或嘗試重連。

    解決方法：

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    如有需要，請使用 `channels login` 重新連結。

  </Accordion>

  <Accordion title="No active listener when sending">
    當目標帳戶沒有作用中的 Gateway 監聽器時，傳送的訊息會快速失敗。

    請確保 Gateway 正在執行且帳戶已連結。

  </Accordion>

  <Accordion title="Group messages unexpectedly ignored">
    依此順序檢查：

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` 允許列表項目
    - 提及門控 (`requireMention` + 提及模式)

  </Accordion>

  <Accordion title="Bun runtime warning">
    WhatsApp Gateway 執行時應使用 Node。Bun 被標記為與穩定的 WhatsApp/Telegram Gateway 操作不相容。
  </Accordion>
</AccordionGroup>

## 設定參考指標

主要參考：

- [Configuration reference - WhatsApp](/gateway/configuration-reference#whatsapp)

高影響力 WhatsApp 欄位：

- 存取：`dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`、`groups`
- 傳輸：`textChunkLimit`、`chunkMode`、`mediaMaxMb`、`sendReadReceipts`、`ackReaction`
- 多帳戶：`accounts.<id>.enabled`、`accounts.<id>.authDir`、帳戶層級覆寫
- 操作：`configWrites`、`debounceMs`、`web.enabled`、`web.heartbeatSeconds`、`web.reconnect.*`
- 工作階段行為：`session.dmScope`、`historyLimit`、`dmHistoryLimit`、`dms.<id>.historyLimit`

## 相關

- [Pairing](/channels/pairing)
- [Channel routing](/channels/channel-routing)
- [Troubleshooting](/channels/troubleshooting)
