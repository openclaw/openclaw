---
summary: "Microsoft Teams 智慧代理支援狀態、功能與設定"
read_when:
  - Working on MS Teams channel features
title: "Microsoft Teams"
---

# Microsoft Teams (外掛程式)

> 「凡入此地者，應拋棄一切希望。」

更新日期：2026-01-21

狀態：支援文字 + 私訊附件；頻道/群組檔案傳送需要 `sharePointSiteId` + Graph 權限（請參閱 [在群組聊天中傳送檔案](#sending-files-in-group-chats)）。投票透過 Adaptive Cards 傳送。

## 需要外掛程式

Microsoft Teams 以外掛程式形式提供，並未與核心安裝捆綁。

**重大變更 (2026.1.15)：** MS Teams 已從核心移出。如果您使用它，則必須安裝此外掛程式。

解釋：保持核心安裝較輕量，並允許 MS Teams 相依性獨立更新。

透過 CLI 安裝 (npm registry)：

```bash
openclaw plugins install @openclaw/msteams
```

本地端結帳 (從 git 儲存庫執行時)：

```bash
openclaw plugins install ./extensions/msteams
```

如果您在設定/新手導覽期間選擇 Teams，並偵測到 git checkout，
OpenClaw 將自動提供本地端安裝路徑。

詳情：[外掛程式](/tools/plugin)

## 快速設定 (初學者)

1. 安裝 Microsoft Teams 外掛程式。
2. 建立 **Azure Bot** (App ID + 客戶端密鑰 + 租戶 ID)。
3. 使用這些憑證設定 OpenClaw。
4. 透過公共 URL 或通道暴露 `/api/messages` (預設埠 3978)。
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

注意：群組聊天預設為封鎖 (`channels.msteams.groupPolicy: "allowlist"`)。若要允許群組回覆，請設定 `channels.msteams.groupAllowFrom` (或使用 `groupPolicy: "open"` 以允許任何成員，受提及限制)。

## 目標

- 透過 Teams 私訊、群組聊天或頻道與 OpenClaw 對話。
- 保持路由確定性：回覆始終傳回它們所來自的頻道。
- 預設為安全的頻道行為（除非另行設定，否則需要提及）。

## 設定寫入

預設情況下，Microsoft Teams 允許寫入由 `/config set|unset` 觸發的設定更新（需要 `commands.config: true`）。

透過以下方式停用：

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 存取控制 (私訊 + 群組)

**私訊存取**

- 預設：`channels.msteams.dmPolicy = "pairing"`。未知的寄件者在核准之前將被忽略。
- `channels.msteams.allowFrom` 接受 AAD 物件 ID、UPN 或顯示名稱。當憑證允許時，精靈會透過 Microsoft Graph 將名稱解析為 ID。

**群組存取**

- 預設：`channels.msteams.groupPolicy = "allowlist"` (除非您新增 `groupAllowFrom`，否則會被封鎖)。使用 `channels.defaults.groupPolicy` 在未設定時覆寫預設值。
- `channels.msteams.groupAllowFrom` 控制哪些寄件者可以在群組聊天/頻道中觸發（會回溯到 `channels.msteams.allowFrom`）。
- 設定 `groupPolicy: "open"` 以允許任何成員（預設仍受提及限制）。
- 若要允許**不適用於任何頻道**，請設定 `channels.msteams.groupPolicy: "disabled"`。

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

- 透過在 `channels.msteams.teams` 下列出 Teams 和頻道來設定群組/頻道回覆的範圍。
- 鍵可以是 Team ID 或名稱；頻道鍵可以是對話 ID 或名稱。
- 當 `groupPolicy="allowlist"` 且存在 Teams 允許清單時，只接受列出的 Teams/頻道（受提及限制）。
- 設定精靈接受 `Team/Channel` 條目並為您儲存它們。
- 在啟動時，OpenClaw 會將 Team/頻道和使用者允許清單名稱解析為 ID (當 Graph 權限允許時)
  並記錄映射；未解析的條目會保留為已輸入的內容。

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

## 運作方式

1. 安裝 Microsoft Teams 外掛程式。
2. 建立 **Azure Bot** (App ID + 密鑰 + 租戶 ID)。
3. 建立一個 **Teams 應用程式套件**，該套件參考 Bot 並包含以下 RSC 權限。
4. 將 Teams 應用程式上傳/安裝到團隊（或用於私訊的個人範圍）。
5. 在 `~/.openclaw/openclaw.json` (或環境變數) 中設定 `msteams` 並啟動 Gateway。
6. Gateway 預設監聽 `/api/messages` 上的 Bot Framework webhook 流量。

## Azure Bot 設定 (先決條件)

在設定 OpenClaw 之前，您需要建立 Azure Bot 資源。

### 步驟 1: 建立 Azure Bot

1. 前往 [建立 Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. 填寫 **基本資訊** 標籤：

   | 欄位              | 值                                                    |
   | ------------------ | -------------------------------------------------------- |
   | **Bot 句柄**     | 您的 Bot 名稱，例如 `openclaw-msteams` (必須是唯一的) |
   | **訂閱**         | 選擇您的 Azure 訂閱                                      |
   | **資源群組**     | 建立新資源或使用現有資源                               |
   | **定價層**       | **免費** 用於開發/測試                                 |
   | **應用程式類型** | **單一租戶** (推薦 - 請參閱下面的備註)                 |
   | **建立類型**     | **建立新的 Microsoft App ID**                          |

> **棄用通知：** 在 2025-07-31 之後，新的多租戶 Bot 建立已被棄用。對於新的 Bot，請使用 **單一租戶**。

3. 按一下 **檢閱 + 建立** → **建立** (等待約 1-2 分鐘)

### 步驟 2: 取得憑證

1. 前往您的 Azure Bot 資源 → **設定**
2. 複製 **Microsoft App ID** → 這是您的 `appId`
3. 按一下 **管理密碼** → 前往 App Registration
4. 在 **憑證與密鑰** → **新建客戶端密鑰** → 複製 **值** → 這是您的 `appPassword`
5. 前往 **概觀** → 複製 **目錄 (租戶) ID** → 這是您的 `tenantId`

### 步驟 3: 設定訊息端點

1. 在 Azure Bot → **設定** 中
2. 將 **訊息端點** 設定為您的 webhook URL：
   - 生產環境：`https://your-domain.com/api/messages`
   - 本地端開發：使用通道 (請參閱下面的 [本地端開發 (通道傳輸)](#local-development-tunneling))

### 步驟 4: 啟用 Teams 頻道

1. 在 Azure Bot → **頻道** 中
2. 點擊 **Microsoft Teams** → 設定 → 儲存
3. 接受服務條款

## 本地端開發 (通道傳輸)

Teams 無法連線到 `localhost`。請使用通道進行本地端開發：

**選項 A: ngrok**

```bash
ngrok http 3978
# 複製 https URL，例如：https://abc123.ngrok.io
# 將訊息端點設定為：https://abc123.ngrok.io/api/messages
```

**選項 B: Tailscale Funnel**

```bash
tailscale funnel 3978
# 使用您的 Tailscale funnel URL 作為訊息端點
```

## Teams 開發人員入口網站 (替代方案)

您可以利用 [Teams 開發人員入口網站](https://dev.teams.microsoft.com/apps)，而不是手動建立 manifest ZIP：

1. 點擊 **+ 新增應用程式**
2. 填寫基本資訊 (名稱、描述、開發人員資訊)
3. 前往 **應用程式功能** → **Bot**
4. 選擇 **手動輸入 Bot ID** 並貼上您的 Azure Bot App ID
5. 勾選範圍：**個人**、**團隊**、**群組聊天**
6. 點擊 **分發** → **下載應用程式套件**
7. 在 Teams 中：**應用程式** → **管理您的應用程式** → **上傳自訂應用程式** → 選擇 ZIP

這通常比手動編輯 JSON manifest 更簡單。

## 測試 Bot

**選項 A: Azure Web Chat (先驗證 webhook)**

1. 在 Azure Portal → 您的 Azure Bot 資源 → **在 Web Chat 中測試**
2. 傳送訊息 - 您應該會看到回覆
3. 這確認了您的 webhook 端點在 Teams 設定之前已正常運作

**選項 B: Teams (應用程式安裝後)**

1. 安裝 Teams 應用程式 (側載或組織目錄)
2. 在 Teams 中找到 Bot 並傳送私訊
3. 檢查 Gateway 記錄檔以了解傳入活動

## 設定 (最簡文字版)

1. **安裝 Microsoft Teams 外掛程式**
   - 從 npm：`openclaw plugins install @openclaw/msteams`
   - 從本地端 checkout：`openclaw plugins install ./extensions/msteams`

2. **Bot 註冊**
   - 建立一個 Azure Bot (見上文) 並記下：
     - 應用程式 ID
     - 客戶端密鑰 (應用程式密碼)
     - 租戶 ID (單一租戶)

3. **Teams 應用程式 manifest**
   - 包含一個 `bot` 條目，其中 `botId = <App ID>`。
   - 範圍：`personal`、`team`、`groupChat`。
   - `supportsFiles: true` (個人範圍檔案處理所需)。
   - 新增 RSC 權限 (如下)。
   - 建立圖示：`outline.png` (32x32) 和 `color.png` (192x192)。
   - 將所有三個檔案壓縮在一起：`manifest.json`、`outline.png`、`color.png`。

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

   您也可以使用環境變數代替設定鍵：
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot 端點**
   - 將 Azure Bot 訊息端點設定為：
     - `https://<host>:3978/api/messages` (或您選擇的路徑/埠)。

6. **執行 Gateway**
   - 當外掛程式安裝且 `msteams` 設定存在憑證時，Teams 頻道會自動啟動。

## 歷史紀錄上下文

- `channels.msteams.historyLimit` 控制有多少近期頻道/群組訊息會被包裝到提示中。
- 若無設定，則回溯至 `messages.groupChat.historyLimit`。設定 `0` 以停用 (預設為 50)。
- 私訊歷史紀錄可透過 `channels.msteams.dmHistoryLimit` (使用者回應) 進行限制。每個使用者的覆寫：`channels.msteams.dms["<user_id>"].historyLimit`。

## 目前 Teams RSC 權限 (Manifest)

這些是我們 Teams 應用程式 manifest 中**現有的資源特定權限**。它們僅適用於應用程式安裝所在的團隊/聊天中。

**適用於頻道 (團隊範圍)：**

- `ChannelMessage.Read.Group` (應用程式) - 接收所有頻道訊息而無需提及
- `ChannelMessage.Send.Group` (應用程式)
- `Member.Read.Group` (應用程式)
- `Owner.Read.Group` (應用程式)
- `ChannelSettings.Read.Group` (應用程式)
- `TeamMember.Read.Group` (應用程式)
- `TeamSettings.Read.Group` (應用程式)

**適用於群組聊天：**

- `ChatMessage.Read.Chat` (應用程式) - 接收所有群組聊天訊息而無需提及

## 範例 Teams Manifest (已刪減)

包含所需欄位的最簡、有效範例。替換 ID 和 URL。

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

### Manifest 注意事項 (必填欄位)

- `bots[].botId` **必須**與 Azure Bot App ID 相符。
- `webApplicationInfo.id` **必須**與 Azure Bot App ID 相符。
- `bots[].scopes` 必須包含您打算使用的介面 (`personal`、`team`、`groupChat`)。
- `bots[].supportsFiles: true` 是個人範圍檔案處理所必需的。
- `authorization.permissions.resourceSpecific` 如果您需要頻道流量，則必須包含頻道讀取/傳送權限。

### 更新現有應用程式

若要更新已安裝的 Teams 應用程式 (例如，新增 RSC 權限)：

1. 使用新設定更新您的 `manifest.json`
2. **增加 `version` 欄位** (例如，`1.0.0` → `1.1.0`)
3. **重新壓縮** manifest 與圖示 (`manifest.json`、`outline.png`、`color.png`)
4. 上傳新的 zip：
   - **選項 A (Teams 管理中心)：** Teams 管理中心 → Teams 應用程式 → 管理應用程式 → 找到您的應用程式 → 上傳新版本
   - **選項 B (側載)：** 在 Teams → 應用程式 → 管理您的應用程式 → 上傳自訂應用程式
5. **對於團隊頻道：** 在每個團隊中重新安裝應用程式，以使新權限生效
6. **完全退出並重新啟動 Teams** (不只是關閉視窗) 以清除快取的應用程式中繼資料

## 功能：僅 RSC 與 Graph

### 僅使用 **Teams RSC** (應用程式已安裝，無 Graph API 權限)

可運作：

- 讀取頻道訊息**文字**內容。
- 傳送頻道訊息**文字**內容。
- 接收**個人 (私訊)** 檔案附件。

不運作：

- 頻道/群組**圖像或檔案內容** (payload 僅包含 HTML 存根)。
- 下載儲存在 SharePoint/OneDrive 中的附件。
- 讀取訊息歷史紀錄 (超出實時 webhook 事件)。

### 結合 **Teams RSC + Microsoft Graph 應用程式權限**

新增：

- 下載託管內容（貼到訊息中的圖片）。
- 下載儲存在 SharePoint/OneDrive 中的檔案附件。
- 透過 Graph 讀取頻道/聊天訊息歷史紀錄。

### RSC 與 Graph API

| 功能              | RSC 權限      | Graph API                           |
| ----------------------- | -------------------- | ----------------------------------- |
| **即時訊息**      | 是 (透過 webhook)    | 否 (僅輪詢)                   |
| **歷史訊息** | 否                   | 是 (可查詢歷史紀錄)             |
| **設定複雜度**    | 僅應用程式 manifest    | 需要管理員同意 + 權杖流程 |
| **離線運作**       | 否 (必須運行) | 是 (隨時查詢)               |

**底線：** RSC 用於即時監聽；Graph API 用於歷史紀錄存取。若要追趕離線時錯過的訊息，您需要具備 `ChannelMessage.Read.All` 的 Graph API（需要管理員同意）。

## 啟用 Graph 的媒體 + 歷史紀錄 (頻道必需)

如果您需要在**頻道**中使用圖片/檔案，或想擷取**訊息歷史紀錄**，您必須啟用 Microsoft Graph 權限並授予管理員同意。

1. 在 Entra ID (Azure AD) **應用程式註冊**中，新增 Microsoft Graph **應用程式權限**：
   - `ChannelMessage.Read.All` (頻道附件 + 歷史紀錄)
   - `Chat.Read.All` 或 `ChatMessage.Read.All` (群組聊天)
2. **授予租戶管理員同意**。
3. 提高 Teams 應用程式 **manifest 版本**，重新上傳，並**在 Teams 中重新安裝應用程式**。
4. **完全退出並重新啟動 Teams** 以清除快取的應用程式中繼資料。

**使用者提及的額外權限：** 在對話中的使用者 @提及功能開箱即用。但是，如果您想動態搜尋和提及**不在當前對話中**的使用者，請新增 `User.Read.All` (應用程式) 權限並授予管理員同意。

## 已知限制

### Webhook 逾時

Teams 透過 HTTP webhook 傳遞訊息。如果處理時間過長（例如，LLM 回應緩慢），您可能會看到：

- Gateway 逾時
- Teams 重試訊息 (導致重複)
- 回覆被丟棄

OpenClaw 透過快速返回並主動傳送回覆來處理此問題，但非常緩慢的回應仍可能導致問題。

### 格式

Teams markdown 比 Slack 或 Discord 更受限制：

- 基本格式設定有效：**粗體**、_斜體_、`程式碼`、連結
- 複雜的 markdown (表格、巢狀清單) 可能無法正確呈現
- Adaptive Cards 支援投票和任意卡片傳送 (見下文)

## 設定

主要設定（請參閱 `/gateway/configuration` 了解共用頻道模式）：

- `channels.msteams.enabled`：啟用/停用頻道。
- `channels.msteams.appId`、`channels.msteams.appPassword`、`channels.msteams.tenantId`：bot 憑證。
- `channels.msteams.webhook.port` (預設 `3978`)
- `channels.msteams.webhook.path` (預設 `/api/messages`)
- `channels.msteams.dmPolicy`：`pairing | allowlist | open | disabled` (預設：pairing)
- `channels.msteams.allowFrom`：私訊的允許清單 (AAD 物件 ID、UPN 或顯示名稱)。當 Graph 存取可用時，精靈會在設定期間將名稱解析為 ID。
- `channels.msteams.textChunkLimit`：輸出文字區塊大小。
- `channels.msteams.chunkMode`：`length` (預設) 或 `newline`，用於在長度區塊之前按空行 (段落邊界) 分割。
- `channels.msteams.mediaAllowHosts`：傳入附件主機的允許清單（預設為 Microsoft/Teams 網域）。
- `channels.msteams.mediaAuthAllowHosts`：用於在媒體重試時附加 Authorization 標頭的允許清單（預設為 Graph + Bot Framework 主機）。
- `channels.msteams.requireMention`：在頻道/群組中需要 @提及 (預設為 true)。
- `channels.msteams.replyStyle`：`thread | top-level` (請參閱 [回覆樣式：執行緒與貼文](#reply-style-threads-vs-posts))。
- `channels.msteams.teams.<teamId>.replyStyle`：每個團隊的覆寫。
- `channels.msteams.teams.<teamId>.requireMention`：每個團隊的覆寫。
- `channels.msteams.teams.<teamId>.tools`：當頻道覆寫缺失時使用的預設每個團隊工具政策覆寫 (`allow`/`deny`/`alsoAllow`)。
- `channels.msteams.teams.<teamId>.toolsBySender`：預設每個團隊每個寄件者工具政策覆寫 (`"*"` 萬用字元支援)。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`：每個頻道的覆寫。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`：每個頻道的覆寫。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`：每個頻道的工具政策覆寫 (`allow`/`deny`/`alsoAllow`)。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`：每個頻道每個寄件者工具政策覆寫 (`"*"` 萬用字元支援)。
- `channels.msteams.sharePointSiteId`：用於群組聊天/頻道中檔案上傳的 SharePoint 網站 ID (請參閱 [在群組聊天中傳送檔案](#sending-files-in-group-chats))。

## 路由與工作階段

- 工作階段鍵遵循標準智慧代理格式（請參閱 [/concepts/session](/concepts/session)）：
  - 私訊共用主要工作階段 (`agent:<agentId>:<mainKey>`)。
  - 頻道/群組訊息使用對話 ID：
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 回覆樣式：執行緒與貼文

Teams 最近針對相同的底層資料模型引入了兩種頻道 UI 樣式：

| 樣式                    | 描述                                               | 推薦的 `replyStyle` |
| ------------------------ | --------------------------------------------------------- | ------------------------ |
| **貼文** (經典)      | 訊息顯示為卡片，下方有執行緒回覆 | `thread` (預設)       |
| **執行緒** (類似 Slack) | 訊息線性流動，更像 Slack                   | `top-level`              |

**問題：** Teams API 不會公開頻道使用的 UI 樣式。如果您使用錯誤的 `replyStyle`：

- 在執行緒樣式頻道中使用 `thread` → 回覆會笨拙地巢狀顯示
- 在貼文樣式頻道中使用 `top-level` → 回覆會顯示為獨立的頂層貼文，而不是在執行緒中

**解決方案：** 根據頻道的設定方式，配置每個頻道的 `replyStyle`：

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

## 附件與圖片

**目前限制：**

- **私訊：** 圖片和檔案附件透過 Teams Bot 檔案 API 運作。
- **頻道/群組：** 附件儲存在 M365 儲存空間 (SharePoint/OneDrive)。Webhook payload 僅包含 HTML 存根，而非實際檔案位元組。**需要 Graph API 權限**才能下載頻道附件。

如果沒有 Graph 權限，包含圖片的頻道訊息將僅以文字形式接收（bot 無法存取圖片內容）。
預設情況下，OpenClaw 僅從 Microsoft/Teams 主機名下載媒體。使用 `channels.msteams.mediaAllowHosts` 進行覆寫（使用 `["*"]` 允許任何主機）。
Authorization 標頭僅針對 `channels.msteams.mediaAuthAllowHosts` 中的主機附加（預設為 Graph + Bot Framework 主機）。請嚴格限制此清單（避免多租戶後綴）。

## 在群組聊天中傳送檔案

Bot 可以使用 FileConsentCard 流程 (內建) 在私訊中傳送檔案。然而，**在群組聊天/頻道中傳送檔案**需要額外設定：

| 情境                  | 檔案傳送方式                           | 所需設定                                    |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| **私訊**                  | FileConsentCard → 使用者接受 → Bot 上傳 | 開箱即用                                   |
| **群組聊天/頻道** | 上傳至 SharePoint → 分享連結            | 需要 `sharePointSiteId` + Graph 權限 |
| **圖片 (任何情境)** | Base64 編碼內嵌                        | 開箱即用                                   |

### 為何群組聊天需要 SharePoint

Bot 沒有個人的 OneDrive 磁碟機 (應用程式身分無法使用 `/me/drive` Graph API 端點)。若要在群組聊天/頻道中傳送檔案，Bot 會將檔案上傳到 **SharePoint 網站**並建立分享連結。

### 設定

1. 在 Entra ID (Azure AD) → 應用程式註冊中**新增 Graph API 權限**：
   - `Sites.ReadWrite.All` (應用程式) - 將檔案上傳到 SharePoint
   - `Chat.Read.All` (應用程式) - 可選，啟用每個使用者的分享連結

2. **授予租戶管理員同意**。

3. **取得您的 SharePoint 網站 ID：**

   ```bash
   # 透過 Graph Explorer 或使用有效權杖的 curl：
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # 範例：針對 "contoso.sharepoint.com/sites/BotFiles" 的網站
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # 回應包括："id": "contoso.sharepoint.com,guid1,guid2"
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

| 權限                              | 分享行為                                          |
| --------------------------------------- | --------------------------------------------------------- |
| 僅 `Sites.ReadWrite.All`              | 組織範圍分享連結 (組織中任何人皆可存取) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 每個使用者分享連結 (僅聊天成員可存取)      |

每個使用者分享更安全，因為只有聊天參與者才能存取檔案。如果缺少 `Chat.Read.All` 權限，Bot 會退回到組織範圍分享。

### 回溯行為

| 情境                                          | 結果                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| 群組聊天 + 檔案 + `sharePointSiteId` 已設定 | 上傳到 SharePoint，傳送分享連結            |
| 群組聊天 + 檔案 + 無 `sharePointSiteId`         | 嘗試 OneDrive 上傳 (可能失敗)，僅傳送文字 |
| 個人聊天 + 檔案                              | FileConsentCard 流程 (無需 SharePoint 即可運作)    |
| 任何情境 + 圖片                               | Base64 編碼內嵌 (無需 SharePoint 即可運作)   |

### 檔案儲存位置

上傳的檔案儲存在已設定的 SharePoint 網站預設文件庫中 `/OpenClawShared/` 資料夾內。

## 投票 (Adaptive Cards)

OpenClaw 將 Teams 投票作為 Adaptive Cards 傳送 (沒有原生的 Teams 投票 API)。

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- 投票由 Gateway 記錄在 `~/.openclaw/msteams-polls.json` 中。
- Gateway 必須保持線上才能記錄投票。
- 投票尚未自動發布結果摘要 (如有需要，請檢查儲存檔案)。

## Adaptive Cards (任意)

使用 `message` 工具或 CLI 將任何 Adaptive Card JSON 物件傳送給 Teams 使用者或對話。

`card` 參數接受一個 Adaptive Card JSON 物件。當提供 `card` 時，訊息文字是可選的。

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

請參閱 [Adaptive Cards 文件](https://adaptivecards.io/) 了解卡片結構和範例。有關目標格式的詳細資訊，請參閱下面的 [目標格式](#target-formats)。

## 目標格式

MSTeams 目標使用前綴來區分使用者和對話：

| 目標類型         | 格式                           | 範例                                             |
| ------------------- | -------------------------------- | --------------------------------------------------- |
| 使用者 (依 ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`         |
| 使用者 (依名稱)      | `user:<display-name>`            | `user:John Smith` (需要 Graph API)              |
| 群組/頻道       | `conversation:<conversation-id>` | `conversation:19:abc123... @thread.tacv2`            |
| 群組/頻道 (原始) | `<conversation-id>`              | `19:abc123... @thread.tacv2` (如果包含 ` @thread`) |

**CLI 範例：**

```bash
# 透過 ID 傳送給使用者
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# 透過顯示名稱傳送給使用者 (觸發 Graph API 查詢)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# 傳送給群組聊天或頻道
openclaw message send --channel msteams --target "conversation:19:abc... @thread.tacv2" --message "Hello"

# 傳送 Adaptive Card 給對話
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

注意：如果沒有 `user:` 前綴，名稱預設為群組/團隊解析。當按顯示名稱定位人員時，始終使用 `user:`。

## 主動傳訊

- 主動傳訊僅在使用者互動**後**才有可能，因為我們屆時會儲存對話參考。
- 請參閱 `/gateway/configuration` 以了解 `dmPolicy` 和允許清單限制。

## 團隊和頻道 ID (常見陷阱)

Teams URL 中的 `groupId` 查詢參數**不是**用於設定的團隊 ID。請從 URL 路徑中擷取 ID：

**團隊 URL：**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    團隊 ID (請進行 URL 解碼)
```

**頻道 URL：**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      頻道 ID (請進行 URL 解碼)
```

**用於設定：**

- 團隊 ID = `/team/` 之後的路徑片段 (URL 解碼，例如 `19:Bk4j... @thread.tacv2`)
- 頻道 ID = `/channel/` 之後的路徑片段 (URL 解碼)
- **忽略** `groupId` 查詢參數

## 私人頻道

Bot 在私人頻道中的支援有限：

| 功能                      | 標準頻道 | 私人頻道       |
| ---------------------------- | ----------------- | ---------------------- |
| Bot 安裝             | 是               | 有限                |
| 即時訊息 (webhook) | 是               | 可能無法運作           |
| RSC 權限              | 是               | 可能表現不同 |
| @提及                    | 是               | 如果 Bot 可存取   |
| Graph API 歷史紀錄            | 是               | 是 (需具備權限) |

**如果私人頻道無法運作的解決方法：**

1. 使用標準頻道進行 Bot 互動
2. 使用私訊 - 使用者可以隨時直接向 Bot 發送訊息
3. 使用 Graph API 進行歷史紀錄存取 (需要 `ChannelMessage.Read.All`)

## 疑難排解

### 常見問題

- **頻道中未顯示圖片：** 缺少 Graph 權限或管理員同意。重新安裝 Teams 應用程式並完全退出/重新開啟 Teams。
- **頻道中沒有回覆：** 預設需要提及；設定 `channels.msteams.requireMention=false` 或針對每個團隊/頻道進行設定。
- **版本不符 (Teams 仍顯示舊的 manifest)：** 移除 + 重新新增應用程式並完全退出 Teams 以重新整理。
- **Webhook 傳回 401 Unauthorized：** 手動測試時未帶 Azure JWT 是預期的 - 表示端點可達，但驗證失敗。請使用 Azure Web Chat 進行正確測試。

### Manifest 上傳錯誤

- **"圖示檔案不能為空"：** Manifest 引用的圖示檔案大小為 0 位元組。請建立有效的 PNG 圖示 (`outline.png` 為 32x32，`color.png` 為 192x192)。
- **"webApplicationInfo.Id 已在使用中"：** 該應用程式仍在其他團隊/聊天中安裝。請先找到並解除安裝，或等待 5-10 分鐘以進行傳播。
- **"上傳時發生錯誤"：** 請改透過 [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) 上傳，開啟瀏覽器開發人員工具 (F12) → 網路標籤，並檢查回應主體以獲取實際錯誤。
- **側載失敗：** 請嘗試「上傳應用程式到組織的應用程式目錄」，而不是「上傳自訂應用程式」- 這通常可以繞過側載限制。

### RSC 權限無法運作

1. 驗證 `webApplicationInfo.id` 與您的 Bot 的 App ID 完全相符
2. 重新上傳應用程式並在團隊/聊天中重新安裝
3. 檢查您的組織管理員是否已封鎖 RSC 權限
4. 確認您使用的是正確的範圍：團隊使用 `ChannelMessage.Read.Group`，群組聊天使用 `ChatMessage.Read.Chat`

## 參考文件

- [建立 Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 設定指南
- [Teams 開發人員入口網站](https://dev.teams.microsoft.com/apps) - 建立/管理 Teams 應用程式
- [Teams 應用程式 manifest 結構](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [透過 RSC 接收頻道訊息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC 權限參考](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams Bot 檔案處理](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (頻道/群組需要 Graph)
- [主動傳訊](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
