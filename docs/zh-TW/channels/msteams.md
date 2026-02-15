---
summary: "Microsoft Teams 機器人支援狀態、功能與設定"
read_when:
  - 處理 MS Teams 頻道功能時
title: "Microsoft Teams"
---

<!-- markdownlint-disable MD024 MD051 -->

# Microsoft Teams (外掛程式)

> "Abandon all hope, ye who enter here."

更新日期：2026-01-21

狀態：支援文字 + 私訊附件；頻道/群組傳送檔案需要 `sharePointSiteId` + Graph 權限（見 [在群組聊天中傳送檔案](#sending-files-in-group-chats)）。投票透過 Adaptive Cards 傳送。

## 需要外掛程式

Microsoft Teams 以外掛程式形式提供，未包含在核心安裝中。

**重大變更 (2026.1.15)：** MS Teams 已移出核心。若要使用，必須安裝外掛程式。

解釋：這能減輕核心安裝的大小，並讓 MS Teams 的相依項目能獨立更新。

透過 CLI (npm 註冊表) 安裝：

```bash
openclaw plugins install @openclaw/msteams
```

本地檢出 (從 git 儲存庫執行時)：

```bash
openclaw plugins install ./extensions/msteams
```

若在設定/新手導覽中選擇 Teams 且偵測到 git 檢出，
OpenClaw 會自動提供本地安裝路徑。

詳情：[Plugins](/tools/plugin)

## 快速開始 (初學者)

1. 安裝 Microsoft Teams 外掛程式。
2. 建立 **Azure Bot** (App ID + 客戶端密鑰 + 租戶 ID)。
3. 使用這些憑證設定 OpenClaw。
4. 透過公開 URL 或通道公開 `/api/messages` (預設連接埠為 3978)。
5. 安裝 Teams 應用程式套件並啟動 Gateway。

最小設定：

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

注意：群組聊天預設為封鎖 (`channels.msteams.groupPolicy: "allowlist"`)。若要允許群組回覆，請設定 `channels.msteams.groupAllowFrom`（或使用 `groupPolicy: "open"` 允許任何成員，受標記限制）。

## 目標

- 透過 Teams 私訊、群組聊天或頻道與 OpenClaw 交談。
- 保持路由確定性：回覆一律傳回到傳入的原始頻道。
- 預設為安全的頻道行為（除非另有設定，否則需要標記 @mention）。

## 設定寫入

預設情況下，允許 Microsoft Teams 寫入由 `/config set|unset` 觸發的設定更新 (需要 `commands.config: true`)。

禁用方式：

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 存取控制 (私訊 + 群組)

**私訊存取**

- 預設：`channels.msteams.dmPolicy = "pairing"`。未經核准前，會忽略未知的傳送者。
- `channels.msteams.allowFrom` 接受 AAD 物件 ID、UPN 或顯示名稱。若權限允許，精靈會透過 Microsoft Graph 將名稱解析為 ID。

**群組存取**

- 預設：`channels.msteams.groupPolicy = "allowlist"`（除非新增 `groupAllowFrom`，否則會封鎖）。未設定時，使用 `channels.defaults.groupPolicy` 覆寫預設值。
- `channels.msteams.groupAllowFrom` 控制哪些傳送者可以觸發群組聊天/頻道（會回退到 `channels.msteams.allowFrom`）。
- 設定 `groupPolicy: "open"` 允許任何成員（預設仍受標記限制）。
- 若要**不允許任何頻道**，請設定 `channels.msteams.groupPolicy: "disabled"`。

範例：

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user @org.com"],
    },
  },
}
```

**Teams + 頻道允許清單**

- 透過在 `channels.msteams.teams` 下列出 Teams 和頻道來限定群組/頻道回覆範圍。
- 鍵名可以是 Team ID 或名稱；頻道鍵名可以是交談 ID 或名稱。
- 當 `groupPolicy="allowlist"` 且存在 Teams 允許清單時，僅接受列出的 Teams/頻道（受標記限制）。
- 設定精靈接受 `Team/Channel` 項目並為您儲存。
- 啟動時，OpenClaw 會將 Team/頻道和使用者允許清單名稱解析為 ID（若 Graph 權限允許）並記錄對應關係；未解析的項目將保持原樣。

範例：

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## 運作原理

1. 安裝 Microsoft Teams 外掛程式。
2. 建立 **Azure Bot** (App ID + 密鑰 + 租戶 ID)。
3. 建立一個 **Teams 應用程式套件**，引用該機器人並包含下方的 RSC 權限。
4. 將 Teams 應用程式上傳/安裝到 Team 中（或私訊的個人範圍）。
5. 在 `~/.openclaw/openclaw.json` (或環境變數) 中設定 `msteams` 並啟動 Gateway。
6. Gateway 預設在 `/api/messages` 監聽 Bot Framework 的 Webhook 流量。

## Azure Bot 設定 (先決條件)

在設定 OpenClaw 之前，您需要建立一個 Azure Bot 資源。

### 步驟 1：建立 Azure Bot

1. 前往 [建立 Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. 填寫 **基本資訊** 分頁：

   | 欄位               | 值                                                 |
   | ------------------ | -------------------------------------------------- |
   | **Bot handle**     | 您的機器人名稱，例如 `openclaw-msteams` (必須唯一) |
   | **Subscription**   | 選擇您的 Azure 訂閱                                |
   | **Resource group** | 建立新資源群組或使用現有的                         |
   | **Pricing tier**   | 開發/測試請選 **Free**                             |
   | **Type of App**    | **Single Tenant** (建議 - 見下方說明)              |
   | **Creation type**  | **Create new Microsoft App ID**                    |

> **淘汰通知：** 2025-07-31 後已停止支援建立新的多租戶 (Multi-tenant) 機器人。新機器人請使用 **Single Tenant**。

3. 點擊 **檢閱 + 建立** → **建立** (等待約 1-2 分鐘)

### 步驟 2：取得憑證

1. 前往您的 Azure Bot 資源 → **設定**
2. 複製 **Microsoft 應用程式 ID** → 這是您的 `appId`
3. 點擊 **管理密碼** → 前往應用程式註冊 (App Registration)
4. 在 **憑證與密鑰** → **新增客戶端密鑰** → 複製 **值** → 這是您的 `appPassword`
5. 前往 **概觀** → 複製 **目錄 (租戶) ID** → 這是您的 `tenantId`

### 步驟 3：設定訊息端點

1. 在 Azure Bot → **設定**
2. 將 **訊息端點** 設定為您的 Webhook URL：
   - 生產環境：`https://your-domain.com/api/messages`
   - 本地開發：使用通道 (見下方的 [本地開發 (通道服務)](#local-development-tunneling))

### 步驟 4：啟用 Teams 頻道

1. 在 Azure Bot → **頻道**
2. 點擊 **Microsoft Teams** → 設定 → 儲存
3. 接受服務條款

## 本地開發 (通道服務)

Teams 無法存取 `localhost`。本地開發請使用通道服務：

**選項 A：ngrok**

```bash
ngrok http 3978
# 複製 https URL，例如 https://abc123.ngrok.io
# 將訊息端點設定為：https://abc123.ngrok.io/api/messages
```

**選項 B：Tailscale Funnel**

```bash
tailscale funnel 3978
# 使用您的 Tailscale funnel URL 作為訊息端點
```

## Teams 開發者入口網站 (替代方案)

除了手動建立資訊清單 (Manifest) ZIP 檔，您也可以使用 [Teams 開發者入口網站](https://dev.teams.microsoft.com/apps)：

1. 點擊 **+ New app**
2. 填寫基本資訊 (名稱、說明、開發者資訊)
3. 前往 **App features** → **Bot**
4. 選擇 **Enter a bot ID manually** 並貼上您的 Azure Bot App ID
5. 勾選範圍：**Personal**、**Team**、**Group Chat**
6. 點擊 **Distribute** → **Download app package**
7. 在 Teams 中：**應用程式** → **管理您的應用程式** → **上傳自訂應用程式** → 選擇該 ZIP 檔

這通常比手動編輯 JSON 資訊清單更容易。

## 測試機器人

**選項 A：Azure Web 測試聊天 (先驗證 Webhook)**

1. 在 Azure 入口網站 → 您的 Azure Bot 資源 → **在 Web 聊天中測試**
2. 傳送訊息 - 您應該會看到回覆
3. 這能在設定 Teams 前確認您的 Webhook 端點正常運作

**選項 B：Teams (安裝應用程式後)**

1. 安裝 Teams 應用程式 (側載或組織目錄)
2. 在 Teams 中找到機器人並傳送私訊
3. 檢查 Gateway 記錄檔中的傳入活動

## 設定 (僅限文字的最小設定)

1. **安裝 Microsoft Teams 外掛程式**
   - 從 npm：`openclaw plugins install @openclaw/msteams`
   - 從本地檢出：`openclaw plugins install ./extensions/msteams`

2. **機器人註冊**
   - 建立 Azure Bot (見上方) 並記錄：
     - 應用程式 ID
     - 客戶端密鑰 (應用程式密碼)
     - 租戶 ID (單租戶)

3. **Teams 應用程式資訊清單**
   - 包含一個 `bot` 項目，其 `botId = <App ID>`。
   - 範圍：`personal`、`team`、`groupChat`。
   - `supportsFiles: true` (個人範圍處理檔案所需)。
   - 新增 RSC 權限 (見下文)。
   - 建立圖示：`outline.png` (32x32) 和 `color.png` (192x192)。
   - 將三個檔案壓縮在一起：`manifest.json`、`outline.png`、`color.png`。

4. **設定 OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   您也可以使用環境變數代替設定鍵名：
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **機器人端點**
   - 將 Azure Bot 訊息端點設定為：
     - `https://<host>:3978/api/messages` (或您選擇的路徑/連接埠)。

6. **執行 Gateway**
   - 安裝外掛程式且存在含有憑證的 `msteams` 設定時，Teams 頻道會自動啟動。

## 歷史紀錄上下文

- `channels.msteams.historyLimit` 控制提示詞中包含多少則最近的頻道/群組訊息。
- 回退至 `messages.groupChat.historyLimit`。設為 `0` 以禁用 (預設為 50)。
- 私訊歷史紀錄可透過 `channels.msteams.dmHistoryLimit` (使用者回合) 限制。各別使用者覆寫：`channels.msteams.dms["<user_id>"].historyLimit`。

## 目前的 Teams RSC 權限 (資訊清單)

這些是我們 Teams 應用程式資訊清單中**現有的資源特定權限 (resourceSpecific)**。它們僅適用於安裝了該應用程式的 Team/聊天中。

**頻道 (Team 範圍)：**

- `ChannelMessage.Read.Group` (Application) - 無需標記 @mention 即可接收所有頻道訊息
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**群組聊天：**

- `ChatMessage.Read.Chat` (Application) - 無需標記 @mention 即可接收所有群組聊天訊息

## Teams 資訊清單範例 (已隱藏敏感資訊)

包含必要欄位的最小有效範例。請替換 ID 和 URL。

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### 資訊清單注意事項 (必填欄位)

- `bots[].botId` **必須**與 Azure Bot 應用程式 ID 匹配。
- `webApplicationInfo.id` **必須**與 Azure Bot 應用程式 ID 匹配。
- `bots[].scopes` 必須包含您計畫使用的介面 (`personal`、`team`、`groupChat`)。
- 個人範圍的檔案處理需要 `bots[].supportsFiles: true`。
- 若要取得頻道流量，`authorization.permissions.resourceSpecific` 必須包含頻道的讀取/傳送權限。

### 更新現有應用程式

若要更新已安裝的 Teams 應用程式 (例如新增 RSC 權限)：

1. 使用新設定更新您的 `manifest.json`
2. **遞增 `version` 欄位** (例如 `1.0.0` → `1.1.0`)
3. **重新壓縮** 資訊清單與圖示 (`manifest.json`、`outline.png`、`color.png`)
4. 上傳新的 zip 檔：
   - **選項 A (Teams 系統管理中心)：** Teams 系統管理中心 → Teams 應用程式 → 管理應用程式 → 找到您的應用程式 → 上傳新版本
   - **選項 B (側載)：** 在 Teams 中 → 應用程式 → 管理您的應用程式 → 上傳自訂應用程式
5. **頻道：** 在每個 Team 中重新安裝應用程式以使新權限生效
6. **完全退出並重啟 Teams** (而不僅是關閉視窗) 以清除快取的應用程式中繼資料

## 功能：僅 RSC vs Graph

### 僅使用 **Teams RSC** (已安裝應用程式，無 Graph API 權限)

可行：

- 讀取頻道訊息的**文字**內容。
- 傳送頻道訊息的**文字**內容。
- 接收**個人 (私訊)** 檔案附件。

不可行：

- 頻道/群組的**圖像或檔案內容** (承載資料僅包含 HTML 虛設常數)。
- 下載儲存在 SharePoint/OneDrive 的附件。
- 讀取訊息歷史紀錄 (超出即時 Webhook 事件的部分)。

### 使用 **Teams RSC + Microsoft Graph 應用程式權限**

新增功能：

- 下載託管內容 (貼在訊息中的圖像)。
- 下載儲存在 SharePoint/OneDrive 的檔案附件。
- 透過 Graph 讀取頻道/聊天訊息歷史紀錄。

### RSC vs Graph API

| 功能           | RSC 權限             | Graph API                 |
| -------------- | -------------------- | ------------------------- |
| **即時訊息**   | 是 (透過 Webhook)    | 否 (僅能輪詢)             |
| **歷史訊息**   | 否                   | 是 (可查詢歷史紀錄)       |
| **設定複雜度** | 僅需應用程式資訊清單 | 需要管理員同意 + 權杖流程 |
| **離線運作**   | 否 (必須執行中)      | 是 (隨時可查詢)           |

**總結：** RSC 用於即時監聽；Graph API 用於歷史存取。若要在離線後補回錯過的訊息，您需要具備 `ChannelMessage.Read.All` 權限的 Graph API (需要管理員同意)。

## 啟用 Graph 的多媒體 + 歷史紀錄 (頻道所需)

若您需要在**頻道**中使用圖像/檔案，或想獲取**訊息歷史紀錄**，必須啟用 Microsoft Graph 權限並授予管理員同意。

1. 在 Entra ID (Azure AD) **應用程式註冊**中，新增 Microsoft Graph **應用程式權限**：
   - `ChannelMessage.Read.All` (頻道附件 + 歷史紀錄)
   - `Chat.Read.All` 或 `ChatMessage.Read.All` (群組聊天)
2. 為租戶**授予管理員同意**。
3. 遞增 Teams 應用程式 **資訊清單版本**、重新上傳並**在 Teams 中重新安裝應用程式**。
4. **完全退出並重啟 Teams** 以清除快取的應用程式中繼資料。

**標記使用者附加權限：** 在交談中的使用者標記功能預設即可運作。然而，若您想動態搜尋並標記**不在目前交談中**的使用者，請新增 `User.Read.All` (Application) 權限並授予管理員同意。

## 已知限制

### Webhook 逾時

Teams 透過 HTTP Webhook 傳送訊息。若處理時間過長 (例如 LLM 回應緩慢)，您可能會看到：

- Gateway 逾時
- Teams 重試傳送訊息 (導致重複)
- 遺失回覆

OpenClaw 的處理方式是快速回傳並主動傳送回覆，但回應極慢時仍可能發生問題。

### 格式設定

Teams 的 Markdown 限制比 Slack 或 Discord 更多：

- 基本格式可行：**粗體**、_斜體_、`程式碼`、連結
- 複雜的 Markdown (表格、巢狀清單) 可能無法正確轉譯
- 支援透過 Adaptive Cards 進行投票或傳送任意卡片 (見下文)

## 設定

關鍵設定 (共用頻道模式請參閱 `/gateway/configuration`)：

- `channels.msteams.enabled`: 啟用/禁用頻道。
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: 機器人憑證。
- `channels.msteams.webhook.port` (預設 `3978`)
- `channels.msteams.webhook.path` (預設 `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (預設: pairing)
- `channels.msteams.allowFrom`: 私訊允許清單 (AAD 物件 ID、UPN 或顯示名稱)。設定期間若具備 Graph 存取權限，精靈會將名稱解析為 ID。
- `channels.msteams.textChunkLimit`: 傳出文字分段大小。
- `channels.msteams.chunkMode`: `length` (預設) 或 `newline` (在分段前先依空白行/段落邊界拆分)。
- `channels.msteams.mediaAllowHosts`: 傳入附件主機的允許清單 (預設為 Microsoft/Teams 網域)。
- `channels.msteams.mediaAuthAllowHosts`: 在多媒體重試時附加 Authorization 標頭的主機允許清單 (預設為 Graph + Bot Framework 主機)。
- `channels.msteams.requireMention`: 在頻道/群組中是否需要標記 @mention (預設為 true)。
- `channels.msteams.replyStyle`: `thread | top-level` (見 [回覆樣式](#reply-style-threads-vs-posts))。
- `channels.msteams.teams.<teamId>.replyStyle`: 各 Team 覆寫設定。
- `channels.msteams.teams.<teamId>.requireMention`: 各 Team 覆寫設定。
- `channels.msteams.teams.<teamId>.tools`: 當缺少頻道覆寫時使用的各 Team 預設工具策略覆寫 (`allow`/`deny`/`alsoAllow`)。
- `channels.msteams.teams.<teamId>.toolsBySender`: 各 Team 針對各傳送者的預設工具策略覆寫 (支援 `"*"` 萬用字元)。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: 各頻道覆寫設定。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: 各頻道覆寫設定。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: 各頻道工具策略覆寫 (`allow`/`deny`/`alsoAllow`)。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: 各頻道針對各傳送者的工具策略覆寫 (支援 `"*"` 萬用字元)。
- `channels.msteams.sharePointSiteId`: 用於群組聊天/頻道檔案上傳的 SharePoint 網站 ID (見 [在群組聊天中傳送檔案](#sending-files-in-group-chats))。

## 路由與工作階段

- 工作階段鍵名遵循標準智慧代理格式 (見 [/concepts/session](/concepts/session))：
  - 私訊共用主工作階段 (`agent:<agentId>:<mainKey>`)。
  - 頻道/群組訊息使用交談 ID：
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 回覆樣式：執行緒 (Threads) vs 貼文 (Posts)

Teams 最近在相同的基礎資料模型上推出了兩種頻道 UI 樣式：

| 樣式                   | 說明                             | 建議的 `replyStyle` |
| ---------------------- | -------------------------------- | ------------------- |
| **Posts** (傳統)       | 訊息顯示為卡片，下方有執行緒回覆 | `thread` (預設)     |
| **Threads** (類 Slack) | 訊息線性流動，較像 Slack         | `top-level`         |

**問題：** Teams API 未公開頻道使用的是哪種 UI 樣式。若使用了錯誤的 `replyStyle`：

- 在 Threads 樣式的頻道中使用 `thread` → 回覆會以尷尬的巢狀方式顯示
- 在 Posts 樣式的頻道中使用 `top-level` → 回覆會顯示為獨立的頂層貼文，而非在執行緒內

**解決方案：** 根據頻道的設定方式為各別頻道設定 `replyStyle`：

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc... @thread.tacv2": {
        "channels": {
          "19:xyz... @thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## 附件與圖像

**目前限制：**

- **私訊：** 圖像與檔案附件可透過 Teams 機器人檔案 API 運作。
- **頻道/群組：** 附件儲存在 M365 儲存空間 (SharePoint/OneDrive)。Webhook 承載資料僅包含 HTML 虛設常數，不包含實際檔案位元組。**下載頻道附件需要 Graph API 權限**。

若無 Graph 權限，包含圖像的頻道訊息將僅以文字形式接收 (機器人無法存取圖像內容)。
預設情況下，OpenClaw 僅從 Microsoft/Teams 主機名稱下載多媒體。可使用 `channels.msteams.mediaAllowHosts` 覆寫 (使用 `["*"]` 允許任何主機)。
Authorization 標頭僅會附加於 `channels.msteams.mediaAuthAllowHosts` 中的主機 (預設為 Graph + Bot Framework 主機)。請嚴格限制此清單 (避免多租戶後綴)。

## 在群組聊天中傳送檔案

機器人可以使用內建的 FileConsentCard 流程在私訊中傳送檔案。然而，**在群組聊天/頻道中傳送檔案**需要額外設定：

| 情境                | 檔案傳送方式                              | 所需設定                             |
| ------------------- | ----------------------------------------- | ------------------------------------ |
| **私訊**            | FileConsentCard → 使用者接受 → 機器人上傳 | 預設即可運作                         |
| **群組聊天/頻道**   | 上傳至 SharePoint → 分享連結              | 需要 `sharePointSiteId` + Graph 權限 |
| **圖像 (任何情境)** | Base64 編碼內嵌                           | 預設即可運作                         |

### 為什麼群組聊天需要 SharePoint

機器人沒有個人 OneDrive 磁碟機 (Graph API 的 `/me/drive` 端點不適用於應用程式身分)。若要在群組聊天/頻道中傳送檔案，機器人會上傳至 **SharePoint 網站**並建立分享連結。

### 設定

1. 在 Entra ID (Azure AD) → 應用程式註冊中**新增 Graph API 權限**：
   - `Sites.ReadWrite.All` (Application) - 上傳檔案至 SharePoint
   - `Chat.Read.All` (Application) - 選用，啟用個別使用者的分享連結

2. 為租戶**授予管理員同意**。

3. **取得您的 SharePoint 網站 ID：**

   ```bash
   # 透過 Graph Explorer 或使用有效權杖執行 curl：
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # 範例：位於 "contoso.sharepoint.com/sites/BotFiles" 的網站
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # 回應包含："id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **設定 OpenClaw：**

   ```json5
   {
     channels: {
       msteams: {
         // ... 其他設定 ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### 分享行為

| 權限                                    | 分享行為                              |
| --------------------------------------- | ------------------------------------- |
| 僅 `Sites.ReadWrite.All`                | 全組織分享連結 (組織內任何人皆可存取) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 個別使用者分享連結 (僅聊天成員可存取) |

個別使用者分享更安全，因為只有聊天參與者可以存取檔案。若遺漏 `Chat.Read.All` 權限，機器人會回退至全組織分享。

### 回退行為

| 情境                                        | 結果                                            |
| ------------------------------------------- | ----------------------------------------------- |
| 群組聊天 + 檔案 + 已設定 `sharePointSiteId` | 上傳至 SharePoint，傳送分享連結                 |
| 群組聊天 + 檔案 + 未設定 `sharePointSiteId` | 嘗試上傳至 OneDrive (可能失敗)，僅傳送文字      |
| 個人聊天 + 檔案                             | FileConsentCard 流程 (無需 SharePoint 即可運作) |
| 任何情境 + 圖像                             | Base64 編碼內嵌 (無需 SharePoint 即可運作)      |

### 檔案儲存位置

上傳的檔案儲存在所設定 SharePoint 網站預設文件庫的 `/OpenClawShared/` 資料夾中。

## 投票 (Adaptive Cards)

OpenClaw 將 Teams 投票作為 Adaptive Cards 傳送 (Teams 無原生投票 API)。

- CLI：`openclaw message poll --channel msteams --target conversation:<id> ...`
- 投票結果由 Gateway 記錄在 `~/.openclaw/msteams-polls.json` 中。
- Gateway 必須保持在線才能記錄投票。
- 投票目前尚不會自動發佈結果摘要 (如有需要請檢查儲存檔案)。

## Adaptive Cards (任意)

使用 `message` 工具或 CLI 將任何 Adaptive Card JSON 傳送給 Teams 使用者或交談。

`card` 參數接受一個 Adaptive Card JSON 物件。提供 `card` 時，訊息文字為選填。

**智慧代理工具：**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI：**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc... @thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

卡片架構與範例請參閱 [Adaptive Cards 文件](https://adaptivecards.io/)。目標格式詳情請見下方的 [目標格式](#target-formats)。

## 目標格式

MSTeams 目標使用前綴來區分使用者與交談：

| 目標類型         | 格式                             | 範例                                            |
| ---------------- | -------------------------------- | ----------------------------------------------- |
| 使用者 (依 ID)   | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`     |
| 使用者 (依名稱)  | `user:<display-name>`            | `user:John Smith` (需要 Graph API)              |
| 群組/頻道        | `conversation:<conversation-id>` | `conversation:19:abc123... @thread.tacv2`       |
| 群組/頻道 (原始) | `<conversation-id>`              | `19:abc123... @thread.tacv2` (若包含 `@thread`) |

**CLI 範例：**

```bash
# 依 ID 傳送給使用者
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# 依顯示名稱傳送給使用者 (會觸發 Graph API 查詢)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# 傳送給群組聊天或頻道
openclaw message send --channel msteams --target "conversation:19:abc... @thread.tacv2" --message "Hello"

# 傳送 Adaptive Card 給交談
openclaw message send --channel msteams --target "conversation:19:abc... @thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**智慧代理工具範例：**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc... @thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

注意：若無 `user:` 前綴，名稱預設會被解析為群組/小組。依顯示名稱指定人員時，請務必使用 `user:`。

## 主動訊息

- 僅在使用者互動**之後**才能傳送主動訊息，因為我們在那時才會儲存交談引用。
- `dmPolicy` 與允許清單過濾請參閱 `/gateway/configuration`。

## Team 與頻道 ID (常見陷阱)

Teams URL 中的 `groupId` 查詢參數**不是**用於設定的 Team ID。請從 URL 路徑中擷取 ID：

**Team URL：**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (請對此進行 URL 解碼)
```

**頻道 URL：**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      頻道 ID (請對此進行 URL 解碼)
```

**設定用：**

- Team ID = `/team/` 後的路徑段落 (URL 解碼後，例如 `19:Bk4j... @thread.tacv2`)
- 頻道 ID = `/channel/` 後的路徑段落 (URL 解碼後)
- **忽略** `groupId` 查詢參數

## 私人頻道

機器人在私人頻道中的支援有限：

| 功能               | 標準頻道 | 私人頻道        |
| ------------------ | -------- | --------------- |
| 機器人安裝         | 是       | 受限            |
| 即時訊息 (Webhook) | 是       | 可能無法運作    |
| RSC 權限           | 是       | 行為可能不同    |
| @mentions          | 是       | 若機器人可存取  |
| Graph API 歷史紀錄 | 是       | 是 (具備權限時) |

**私人頻道無法運作時的替代方案：**

1. 使用標準頻道進行機器人互動
2. 使用私訊 - 使用者隨時可以直接傳訊給機器人
3. 使用 Graph API 進行歷史存取 (需要 `ChannelMessage.Read.All`)

## 疑難排解

### 常見問題

- **頻道中不顯示圖像：** 遺漏 Graph 權限或管理員同意。請重新安裝 Teams 應用程式並完全退出/重開 Teams。
- **頻道中無回應：** 預設需要標記；請設定 `channels.msteams.requireMention=false` 或針對個別 Team/頻道進行設定。
- **版本不匹配 (Teams 仍顯示舊的資訊清單)：** 移除並重新加入應用程式，並完全退出 Teams 以重新整理。
- **來自 Webhook 的 401 Unauthorized：** 在不含 Azure JWT 的情況下手動測試時的預期結果 - 代表端點可連達但認證失敗。請使用 Azure Web 聊天進行正確測試。

### 資訊清單上傳錯誤

- **"Icon file cannot be empty"：** 資訊清單引用的圖示檔案為 0 位元組。請建立有效的 PNG 圖示 (32x32 為 `outline.png`，192x192 為 `color.png`)。
- **"webApplicationInfo.Id already in use"：** 該應用程式仍安裝在另一個 Team/聊天中。請先找到並解除安裝，或等待 5-10 分鐘讓變更生效。
- **上傳時顯示 "Something went wrong"：** 改透過 [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) 上傳，開啟瀏覽器開發者工具 (F12) → Network 分頁，檢查回應主體以獲取實際錯誤訊息。
- **側載失敗：** 嘗試「上傳應用程式至您的組織應用程式目錄」，而非「上傳自訂應用程式」 - 這通常能繞過側載限制。

### RSC 權限失效

1. 驗證 `webApplicationInfo.id` 是否與您的機器人應用程式 ID 完全匹配
2. 重新上傳應用程式並在 Team/聊天中重新安裝
3. 檢查您的組織管理員是否封鎖了 RSC 權限
4. 確認您使用的是正確的範圍：Team 請用 `ChannelMessage.Read.Group`，群組聊天請用 `ChatMessage.Read.Chat`

## 參考資料

- [建立 Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 設定指南
- [Teams 開發者入口網站](https://dev.teams.microsoft.com/apps) - 建立/管理 Teams 應用程式
- [Teams 應用程式資訊清單架構](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [透過 RSC 接收頻道訊息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC 權限參考](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams 機器人檔案處理](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (頻道/群組需要 Graph)
- [主動訊息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
