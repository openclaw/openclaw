---
summary: "WhatsApp 頻道支援、存取控制、傳輸行為及運作"
read_when:
  - 處理 WhatsApp/網頁頻道行為或收件匣路由時
title: "WhatsApp"
---

# WhatsApp (網頁頻道)

狀態：透過 WhatsApp Web (Baileys) 已可用於正式環境。Gateway 擁有連結的工作階段。

<CardGroup cols={3}>
  <Card title="配對" icon="link" href="/channels/pairing">
    針對未知傳送者的預設私訊政策為配對。
  </Card>
  <Card title="頻道疑難排解" icon="wrench" href="/channels/troubleshooting">
    跨頻道診斷與修復指南。
  </Card>
  <Card title="Gateway 設定" icon="settings" href="/gateway/configuration">
    完整的頻道設定模式與範例。
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

    針對特定帳號：

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="啟動 Gateway">

```bash
openclaw gateway
```

  </Step>

  <Step title="核准第一個配對請求（如果使用配對模式）">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    配對請求將在 1 小時後過期。每個頻道的待處理請求上限為 3 個。

  </Step>
</Steps>

<Note>
OpenClaw 建議盡可能在獨立號碼上執行 WhatsApp。（頻道詮釋資料與新手導覽流程已針對該設定進行優化，但亦支援個人號碼設定。）
</Note>

## 部署模式

<AccordionGroup>
  <Accordion title="獨立號碼（推薦）">
    這是最簡潔的運作模式：

    - OpenClaw 擁有獨立的 WhatsApp 身分
    - 更清晰的私訊允許清單與路由邊界
    - 降低自我對話混淆的機率

    最小化政策模式：

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

  <Accordion title="個人號碼備援">
    新手導覽支援個人號碼模式，並寫入對自我對話友善的基準設定：

    - `dmPolicy: "allowlist"`
    - `allowFrom` 包含您的個人號碼
    - `selfChatMode: true`

    在執行期間，自我對話保護機制會根據連結的自身號碼與 `allowFrom` 觸發。

  </Accordion>

  <Accordion title="僅限 WhatsApp Web 頻道範圍">
    在目前的 OpenClaw 頻道架構中，訊息平台頻道是基於 WhatsApp Web (`Baileys`) 的。

    內建的聊天頻道註冊表中沒有獨立的 Twilio WhatsApp 訊息頻道。

  </Accordion>
</AccordionGroup>

## 執行模型

- Gateway 擁有 WhatsApp socket 與重新連線迴圈。
- 對外傳送需要目標帳號有活躍的 WhatsApp 監聽器。
- 動態 (Status) 與廣播聊天會被忽略 (`@status`, `@broadcast`)。
- 直接聊天使用私訊工作階段規則 (`session.dmScope`；預設值 `main` 會將私訊摺疊至智慧代理主工作階段)。
- 群組工作階段是隔離的 (`agent:<agentId>:whatsapp:group:<jid>`)。

## 存取控制與啟用

<Tabs>
  <Tab title="私訊政策">
    `channels.whatsapp.dmPolicy` 控制直接聊天的存取：

    - `pairing` (預設)
    - `allowlist`
    - `open` (需要 `allowFrom` 包含 `"*"`)
    - `disabled`

    `allowFrom` 接受 E.164 格式的號碼（內部會進行正規化）。

    執行行為詳情：

    - 配對會持久化儲存在頻道的允許儲存庫 (allow-store) 中，並與設定的 `allowFrom` 合併
    - 若未設定允許清單，預設允許連結的自身號碼
    - 對外發送的 `fromMe` 私訊永遠不會自動配對

  </Tab>

  <Tab title="群組政策 + 允許清單">
    群組存取分為兩層：

    1. **群組成員允許清單** (`channels.whatsapp.groups`)
       - 若省略 `groups`，所有群組均符合資格
       - 若存在 `groups`，它會作為群組允許清單（允許 `"*"`）

    2. **群組傳送者政策** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open`：跳過傳送者允許清單
       - `allowlist`：傳送者必須符合 `groupAllowFrom`（或 `*`）
       - `disabled`：阻擋所有群組傳入

    傳送者允許清單備援：

    - 若未設定 `groupAllowFrom`，執行時會視情況備援至 `allowFrom`

    注意：若完全不存在 `channels.whatsapp` 區塊，執行時的群組政策備援實際上為 `open`。

  </Tab>

  <Tab title="提及 (Mentions) + /activation">
    群組回覆預設需要提及。

    提及偵測包括：

    - 明確提及機器人身分的 WhatsApp 提及
    - 設定的提及正規表達式模式 (`agents.list[].groupChat.mentionPatterns`，備援至 `messages.groupChat.mentionPatterns`)
    - 隱式回覆機器人偵測（回覆傳送者符合機器人身分）

    工作階段層級的啟用指令：

    - `/activation mention`
    - `/activation always`

    `activation` 會更新工作階段狀態（而非全域設定）。受限於擁有者權限。

  </Tab>
</Tabs>

## 個人號碼與自我對話行為

當連結的自身號碼也存在於 `allowFrom` 時，WhatsApp 自我對話保護機制會啟動：

- 略過自我對話輪次的已讀回條
- 忽略會標註您自己的 mention-JID 自動觸發行為
- 若未設定 `messages.responsePrefix`，自我對話回覆預設為 `[{identity.name}]` 或 `[openclaw]`

## 訊息正規化與內容 (Context)

<AccordionGroup>
  <Accordion title="傳入封包 + 回覆內容">
    傳入的 WhatsApp 訊息會包裝在共享的傳入封包中。

    如果存在引用的回覆，內容會以此格式附加：

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    回覆詮釋資料欄位也會在可用時填充 (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, 傳送者 JID/E.164)。

  </Accordion>

  <Accordion title="媒體預留位置與位置/聯絡人擷取">
    僅限媒體的傳入訊息會使用預留位置進行正規化，例如：

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    位置與聯絡人承載內容在路由之前會先正規化為文字內容。

  </Accordion>

  <Accordion title="待處理群組歷史紀錄插入">
    對於群組，未處理的訊息可以被緩衝，並在機器人最終觸發時作為內容插入。

    - 預設限制：`50`
    - 設定：`channels.whatsapp.historyLimit`
    - 備援：`messages.groupChat.historyLimit`
    - `0` 表示停用

    插入標記：

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="已讀回條">
    對於接受的傳入 WhatsApp 訊息，預設會啟用已讀回條。

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

    各別帳號覆寫：

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

    即使已全域啟用，自我對話輪次也會略過已讀回條。

  </Accordion>
</AccordionGroup>

## 傳輸、分塊與媒體

<AccordionGroup>
  <Accordion title="文字分塊">
    - 預設分塊限制：`channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` 模式優先考慮段落邊界（空行），然後備援至長度安全的分塊
  </Accordion>

  <Accordion title="對外媒體行為">
    - 支援影像、影片、音訊（PTT 語音訊息）與檔案承載內容
    - `audio/ogg` 會被重寫為 `audio/ogg; codecs=opus` 以維持語音訊息相容性
    - 透過在影片傳送時設定 `gifPlayback: true` 來支援動態 GIF 播放
    - 傳送多媒體回覆承載內容時，說明文字會套用至第一個媒體項目
    - 媒體來源可以是 HTTP(S)、`file://` 或本機路徑
  </Accordion>

  <Accordion title="媒體大小限制與備援行為">
    - 傳入媒體儲存上限：`channels.whatsapp.mediaMaxMb` (預設 `50`)
    - 自動回覆的對外媒體上限：`agents.defaults.mediaMaxMb` (預設 `5MB`)
    - 影像會自動優化（調整大小/品質掃描）以符合限制
    - 當媒體傳送失敗時，第一個項目的備援機制會傳送文字警告，而非無聲地捨棄回應
  </Accordion>
</AccordionGroup>

## 確認回應 (Acknowledgment reactions)

WhatsApp 支援透過 `channels.whatsapp.ackReaction` 在收到傳入訊息時立即進行確認回應。

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

行為說明：

- 在傳入訊息被接受後立即傳送（回覆前）
- 失敗會被記錄，但不會阻礙正常的回覆傳輸
- 群組模式 `mentions` 會在提及觸發的輪次做出回應；群組啟用 `always` 則會跳過此檢查
- WhatsApp 使用 `channels.whatsapp.ackReaction`（此處不使用舊版的 `messages.ackReaction`）

## 多帳號與憑證

<AccordionGroup>
  <Accordion title="帳號選擇與預設值">
    - 帳號 ID 來自 `channels.whatsapp.accounts`
    - 預設帳號選擇：若存在 `default` 則優先選用，否則選用第一個設定的帳號 ID（排序後）
    - 帳號 ID 會在內部進行正規化以便查找
  </Accordion>

  <Accordion title="憑證路徑與舊版相容性">
    - 目前驗證路徑：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - 備份檔案：`creds.json.bak`
    - `~/.openclaw/credentials/` 中的舊版預設驗證仍可被辨識，並會針對預設帳號流程進行遷移
  </Accordion>

  <Accordion title="登出行為">
    `openclaw channels logout --channel whatsapp [--account <id>]` 會清除該帳號的 WhatsApp 驗證狀態。

    在舊版驗證目錄中，`oauth.json` 會被保留，而 Baileys 驗證檔案則會被移除。

  </Accordion>
</AccordionGroup>

## 工具、動作與設定寫入

- 智慧代理工具支援包括 WhatsApp 回應動作 (`react`)。
- 動作閘：
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- 預設啟用由頻道發起的設定寫入（可透過 `channels.whatsapp.configWrites=false` 停用）。

## 疑難排解

<AccordionGroup>
  <Accordion title="未連結（需要 QR Code）">
    症狀：頻道狀態報告為未連結。

    修復：

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="已連結但斷線 / 重新連線迴圈">
    症狀：已連結帳號重複斷線或嘗試重新連線。

    修復：

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    如有需要，請使用 `channels login` 重新連結。

  </Accordion>

  <Accordion title="傳送時無活躍監聽器">
    當目標帳號不存在活躍的 Gateway 監聽器時，對外傳送會立即失敗。

    請確保 Gateway 正在執行且帳號已連結。

  </Accordion>

  <Accordion title="群組訊息意外被忽略">
    請依此順序檢查：

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` 允許清單項目
    - 提及控制 (`requireMention` + 提及模式)

  </Accordion>

  <Accordion title="Bun 執行環境警告">
    WhatsApp Gateway 執行環境應使用 Node。Bun 被標記為不相容於穩定的 WhatsApp/Telegram Gateway 運作。
  </Accordion>
</AccordionGroup>

## 設定參考指標

主要參考：

- [設定參考 - WhatsApp](/gateway/configuration-reference#whatsapp)

高重要性 WhatsApp 欄位：

- 存取：`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- 傳輸：`textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`
- 多帳號：`accounts.<id>.enabled`, `accounts.<id>.authDir`, 帳號層級覆寫
- 運作：`configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`
- 工作階段行為：`session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`

## 相關內容

- [配對](/channels/pairing)
- [頻道路由](/channels/channel-routing)
- [疑難排解](/channels/troubleshooting)
