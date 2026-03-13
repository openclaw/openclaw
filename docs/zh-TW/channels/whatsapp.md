---
summary: "WhatsApp channel support, access controls, delivery behavior, and operations"
read_when:
  - Working on WhatsApp/web channel behavior or inbox routing
title: WhatsApp
---

# WhatsApp (網頁通道)

狀態：透過 WhatsApp Web (Baileys) 已準備好投入生產。網關擁有已連結的會話。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    預設的 DM 政策是對未知發送者進行配對。
  </Card>
  <Card title="頻道故障排除" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷和修復手冊。
  </Card>
  <Card title="閘道設定" icon="settings" href="/gateway/configuration">
    完整的頻道設定範本和範例。
  </Card>
</CardGroup>

## 快速設定

<Steps>
  <Step title="設定 WhatsApp 存取政策">

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

<Step title="連結 WhatsApp (QR)">

```bash
openclaw channels login --channel whatsapp
```

對於特定帳戶：

```bash
openclaw channels login --channel whatsapp --account work
```

</Step>

<Step title="啟動閘道">

```bash
openclaw gateway
```

</Step>

<Step title="批准第一次配對請求（如果使用配對模式）">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

配對請求在 1 小時後過期。每個頻道的待處理請求上限為 3 個。

</Step>
</Steps>

<Note>
OpenClaw 建議在可能的情況下，使用單獨的號碼執行 WhatsApp。（該通道的元數據和入門流程已針對該設置進行優化，但也支援個人號碼設置。）
</Note>

## 部署模式

<AccordionGroup>
  <Accordion title="專用號碼（推薦）">
    這是最乾淨的操作模式：

- 為 OpenClaw 分開 WhatsApp 身份
  - 更清晰的 DM 允許名單和路由邊界
  - 降低自我聊天混淆的機會

[[BLOCK_1]]  
最小政策模式：  
[[BLOCK_1]]

````json5
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
    上線支援個人號碼模式，並撰寫一個適合自我對話的基準：

- `dmPolicy: "allowlist"`
    - `allowFrom` 包含您的個人號碼
    - `selfChatMode: true`

在執行時，自我聊天保護會根據連結的自我號碼和 `allowFrom` 進行啟動。

</Accordion>

<Accordion title="WhatsApp Web-only channel scope">
    此訊息平台通道是基於 WhatsApp Web (`Baileys`) 的，屬於目前 OpenClaw 通道架構。

內建的聊天通道註冊表中沒有單獨的 Twilio WhatsApp 訊息通道。

</Accordion>
</AccordionGroup>

## Runtime model

- Gateway 擁有 WhatsApp 的 socket 和重連循環。
- 外發請求需要目標帳戶的活躍 WhatsApp 監聽器。
- 狀態和廣播聊天會被忽略 (`@status`, `@broadcast`)。
- 直接聊天使用 DM 會話規則 (`session.dmScope`; 預設 `main` 將 DMs 合併到代理的主要會話中)。
- 群組會話是隔離的 (`agent:<agentId>:whatsapp:group:<jid>`)。

## 存取控制與啟用

<Tabs>
  <Tab title="DM 政策">
    `channels.whatsapp.dmPolicy` 控制直接聊天訪問：

- `pairing` (預設)
    - `allowlist`
    - `open` (需要 `allowFrom` 來包含 `"*"`)
    - `disabled`

`allowFrom` 接受 E.164 格式的號碼（內部已正規化）。

多帳戶覆蓋：`channels.whatsapp.accounts.<id>.dmPolicy`（和 `allowFrom`）優先於該帳戶的頻道級預設值。

[[BLOCK_1]]
執行時行為詳細資訊：
[[BLOCK_1]]

- 配對會被持久化在頻道 allow-store 中，並與設定的 `allowFrom` 合併
    - 如果未設定允許清單，則預設允許連結的自我號碼
    - 外發的 `fromMe` 直接訊息永遠不會自動配對

</Tab>

<Tab title="群組政策 + 允許清單">
    群組存取有兩個層級：

1. **群組成員資格白名單** (`channels.whatsapp.groups`)
       - 如果 `groups` 被省略，則所有群組皆可參加
       - 如果 `groups` 存在，它將作為群組白名單 (`"*"` 允許)

2. **群組發送者政策** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open`: 發送者允許清單被繞過
       - `allowlist`: 發送者必須符合 `groupAllowFrom` (或 `*`)
       - `disabled`: 阻擋所有群組進入訊息

Sender allowlist fallback:

- 如果 `groupAllowFrom` 未設定，執行時會在可用時回退到 `allowFrom`
    - 發送者的白名單在提及/回覆啟用之前會被評估

注意：如果根本不存在 `channels.whatsapp` 區塊，則執行時群組政策回退為 `allowlist`（並帶有警告日誌），即使 `channels.defaults.groupPolicy` 已設定。

</Tab>

<Tab title="提及 + /啟用">
    群組回覆預設需要提及。

提及檢測包括：

- 明確的 WhatsApp 提及機器人身份
    - 設定的提及正則表達式模式 (`agents.list[].groupChat.mentionPatterns`，後備 `messages.groupChat.mentionPatterns`)
    - 隱式的回覆機器人檢測（回覆發送者與機器人身份匹配）

安全提示：

- 引用/回覆僅滿足提及限制；它並**不**授予發送者授權
    - 使用 `groupPolicy: "allowlist"` 時，即使非允許的發送者回覆允許的用戶的訊息，仍然會被阻擋。

Session-level activation command:

- `/activation mention`
    - `/activation always`

`activation` 更新會話狀態（而非全域設定）。它是擁有者限制的。

</Tab>
</Tabs>

## Personal-number 和自我對話行為

當連結的自我數字也存在於 `allowFrom` 中時，WhatsApp 自我聊天的安全措施會啟動：

- 跳過自我聊天回合的已讀回執
- 忽略提及 JID 自動觸發行為，否則會自我提醒
- 如果 `messages.responsePrefix` 未設定，自我聊天的回覆預設為 `[{identity.name}]` 或 `[openclaw]`

## Message normalization and context

<AccordionGroup>
  <Accordion title="進來的信封 + 回覆上下文">
    進來的 WhatsApp 訊息被包裹在共享的進來信封中。

如果存在引用的回覆，則上下文將以以下形式附加：

```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

回覆的元資料欄位在可用時也會被填寫 (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, 發件者 JID/E.164)。

</Accordion>

<Accordion title="媒體佔位符與位置/聯絡資訊擷取">
    僅媒體的進站訊息會使用佔位符進行標準化，例如：

- `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

位置和聯絡資訊的有效載荷在路由之前會被標準化為文本上下文。

</Accordion>

<Accordion title="待處理的群組歷史注入">
    對於群組，未處理的訊息可以被緩衝並在機器人最終被觸發時作為上下文注入。

- 預設限制: `50`
    - 設定: `channels.whatsapp.historyLimit`
    - 備用: `messages.groupChat.historyLimit`
    - `0` 禁用

Injection markers:

- `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

</Accordion>

<Accordion title="已讀回執">
    已讀回執預設為啟用，適用於已接受的進入 WhatsApp 訊息。

禁用全域：

```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

[[BLOCK_1]]

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

自我聊天即使在全域啟用的情況下也會跳過已讀回條。

</Accordion>
</AccordionGroup>

## Delivery, chunking, and media

<AccordionGroup>
  <Accordion title="文本分塊">
    - 預設分塊限制: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` 模式偏好段落邊界（空行），然後回退到長度安全的分塊
  </Accordion>
</AccordionGroup>

<Accordion title="外部媒體行為">
    - 支援圖片、影片、音訊（PTT 語音備忘錄）和文件有效載荷
    - `audio/ogg` 被重寫為 `audio/ogg; codecs=opus` 以兼容語音備忘錄
    - 動畫 GIF 播放透過 `gifPlayback: true` 在影片發送中支援
    - 當發送多媒體回覆有效載荷時，標題會應用於第一個媒體專案
    - 媒體來源可以是 HTTP(S)、`file://` 或本地路徑
</Accordion>

<Accordion title="媒體大小限制與回退行為">
    - 輸入媒體保存上限: `channels.whatsapp.mediaMaxMb` (預設 `50`)
    - 輸出媒體發送上限: `channels.whatsapp.mediaMaxMb` (預設 `50`)
    - 每個帳戶的覆蓋使用 `channels.whatsapp.accounts.<accountId>.mediaMaxMb`
    - 圖片會自動優化（調整大小/品質掃描）以符合限制
    - 在媒體發送失敗時，第一項回退會發送文字警告，而不是靜默丟棄回應
</Accordion>

## Acknowledgment reactions

WhatsApp 支援透過 `channels.whatsapp.ackReaction` 對進來的收據進行即時確認反應。

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
````

[[BLOCK_1]]

- 在接受到入站請求後立即發送（預回覆）
- 失敗會被記錄，但不會阻礙正常的回覆傳遞
- 群組模式 `mentions` 對提及觸發的回合做出反應；群組啟用 `always` 作為此檢查的旁路
- WhatsApp 使用 `channels.whatsapp.ackReaction`（舊版 `messages.ackReaction` 在此不使用）

## 多帳號與憑證

<AccordionGroup>
  <Accordion title="帳戶選擇與預設值">
    - 帳戶 ID 來自 `channels.whatsapp.accounts`
    - 預設帳戶選擇：`default`（如果存在），否則為第一個已設定的帳戶 ID（已排序）
    - 帳戶 ID 在內部進行標準化以便查詢
  </Accordion>
</AccordionGroup>

<Accordion title="憑證路徑與舊版相容性">
    - 當前認證路徑: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - 備份檔案: `creds.json.bak`
    - 在 `~/.openclaw/credentials/` 中的舊版預設認證仍然被識別/遷移以用於預設帳戶流程
</Accordion>

<Accordion title="登出行為">
    `openclaw channels logout --channel whatsapp [--account <id>]` 會清除該帳戶的 WhatsApp 認證狀態。

在舊版認證目錄中，`oauth.json` 被保留，而 Baileys 認證檔案則被移除。

</Accordion>
</AccordionGroup>

## Tools, actions, and config writes

- 代理工具支援包括 WhatsApp 反應動作 (`react`)。
- 動作閘道：
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- 頻道啟動的設定寫入預設為啟用（可透過 `channels.whatsapp.configWrites=false` 停用）。

## 故障排除

<AccordionGroup>
  <Accordion title="未連結（需要 QR）">
    症狀：頻道狀態報告未連結。

[[BLOCK_1]]

````bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

</Accordion>

<Accordion title="已連結但斷開 / 重新連接循環">
    症狀：已連結的帳戶不斷斷開或嘗試重新連接。

[[BLOCK_1]]

```bash
    openclaw doctor
    openclaw logs --follow
    ```

如果需要，請重新連結至 `channels login`。

</Accordion>

<Accordion title="沒有活動的監聽器時發送失敗">
    當目標帳戶沒有活動的閘道監聽器時，外發發送會快速失敗。

確保網關正在執行，並且帳戶已連結。

</Accordion>

<Accordion title="群組訊息意外被忽略">
    按照以下順序檢查：

- `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` 允許清單條目
    - 提及限制 (`requireMention` + 提及模式)
    - `openclaw.json` 中的重複鍵 (JSON5)：後面的條目會覆蓋前面的條目，因此每個範疇應保持單一的 `groupPolicy`

</Accordion>

<Accordion title="Bun 執行時警告">
    WhatsApp 閘道執行時應使用 Node。Bun 被標記為不相容於穩定的 WhatsApp/Telegram 閘道操作。
</Accordion>
</AccordionGroup>

## 設定參考指標

[[BLOCK_1]]

- [設定參考 - WhatsApp](/gateway/configuration-reference#whatsapp)

High-signal WhatsApp fields:

- 存取: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- 交付: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`
- 多帳戶: `accounts.<id>.enabled`, `accounts.<id>.authDir`, 帳戶層級的覆寫
- 操作: `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`
- 會話行為: `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`

## Related

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [多代理路由](/concepts/multi-agent)
- [故障排除](/channels/troubleshooting)
````
