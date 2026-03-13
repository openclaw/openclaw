---
summary: "Microsoft Teams bot support status, capabilities, and configuration"
read_when:
  - Working on MS Teams channel features
title: Microsoft Teams
---

# Microsoft Teams (插件)

> "放棄所有希望，進入此地者。"

更新日期：2026-01-21

狀態：文字 + DM 附件已支援；頻道/群組檔案傳送需要 `sharePointSiteId` + Graph 權限（請參見 [在群組聊天中傳送檔案](#sending-files-in-group-chats)）。投票是透過自適應卡片發送的。

## 需要插件

Microsoft Teams 作為一個插件發佈，並不與核心安裝包捆綁在一起。

**重大變更 (2026.1.15):** MS Teams 已經移出核心。如果您使用它，必須安裝插件。

可解釋性：保持核心安裝輕量，並讓 MS Teams 依賴項獨立更新。

透過 CLI 安裝（npm 註冊表）：

```bash
openclaw plugins install @openclaw/msteams
```

[[BLOCK_1]]  
本地檢出（當從 git 倉庫執行時）：  
[[BLOCK_1]]

```bash
openclaw plugins install ./extensions/msteams
```

如果您在設定/入門過程中選擇 Teams，並且檢測到 git checkout，OpenClaw 將自動提供本地安裝路徑。

[[INLINE_1]]

## 快速設置（初學者）

1. 安裝 Microsoft Teams 外掛程式。
2. 創建一個 **Azure Bot**（應用程式 ID + 用戶端密鑰 + 租戶 ID）。
3. 使用這些憑證設定 OpenClaw。
4. 通過公共 URL 或隧道暴露 `/api/messages`（預設端口 3978）。
5. 安裝 Teams 應用程式包並啟動網關。

[[BLOCK_1]]  
最小設定：  
[[BLOCK_1]]

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

注意：群組聊天預設是被封鎖的 (`channels.msteams.groupPolicy: "allowlist"`). 若要允許群組回覆，請設定 `channels.msteams.groupAllowFrom` (或使用 `groupPolicy: "open"` 來允許任何成員，需提及限制)。

## 目標

- 透過 Teams 直接訊息、群組聊天或頻道與 OpenClaw 交談。
- 保持路由確定性：回覆始終返回到它們到達的頻道。
- 預設為安全頻道行為（除非另行設定，否則需要提及）。

## Config writes

預設情況下，Microsoft Teams 允許寫入由 `/config set|unset` 觸發的設定更新（需要 `commands.config: true`）。

禁用方法：

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 存取控制 (私訊 + 群組)

**DM 存取**

- 預設: `channels.msteams.dmPolicy = "pairing"`。未知的發件者在獲得批准之前會被忽略。
- `channels.msteams.allowFrom` 應使用穩定的 AAD 物件 ID。
- UPNs/顯示名稱是可變的；直接匹配預設是禁用的，僅在 `channels.msteams.dangerouslyAllowNameMatching: true` 啟用時才會開啟。
- 當憑證允許時，精靈可以通過 Microsoft Graph 將名稱解析為 ID。

**群組存取**

- 預設: `channels.msteams.groupPolicy = "allowlist"`（除非您添加 `groupAllowFrom`，否則將被阻止）。使用 `channels.defaults.groupPolicy` 在未設置時覆蓋預設值。
- `channels.msteams.groupAllowFrom` 控制哪些發送者可以在群組聊天/頻道中觸發（回退到 `channels.msteams.allowFrom`）。
- 設定 `groupPolicy: "open"` 以允許任何成員（預設仍然受提及限制）。
- 若要不允許**任何頻道**，請設置 `channels.msteams.groupPolicy: "disabled"`。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**團隊 + 頻道白名單**

- 根據 `channels.msteams.teams` 列出團隊和頻道，以範圍化群組/頻道回覆。
- 鍵值應使用穩定的團隊 ID 和頻道對話 ID。
- 當 `groupPolicy="allowlist"` 和團隊白名單存在時，僅接受列出的團隊/頻道（提及限制）。
- 設定精靈接受 `Team/Channel` 條目並為您儲存它們。
- 在啟動時，OpenClaw 會解析團隊/頻道和用戶白名單名稱為 ID（當 Graph 權限允許時），並記錄映射；未解析的團隊/頻道名稱將保持原樣但預設忽略路由，除非啟用 `channels.msteams.dangerouslyAllowNameMatching: true`。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

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

## 如何運作

1. 安裝 Microsoft Teams 外掛程式。
2. 創建一個 **Azure Bot**（應用程式 ID + 密鑰 + 租戶 ID）。
3. 建立一個 **Teams 應用程式包**，該包引用了機器人並包含以下 RSC 權限。
4. 將 Teams 應用程式上傳/安裝到團隊中（或用於直接訊息的個人範圍）。
5. 在 `msteams` 中設定 `~/.openclaw/openclaw.json`（或環境變數），並啟動網關。
6. 網關預設在 `/api/messages` 上監聽 Bot Framework webhook 流量。

## Azure Bot 設定（前置條件）

在設定 OpenClaw 之前，您需要創建一個 Azure Bot 資源。

### 步驟 1：建立 Azure Bot

1. 前往 [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. 填寫 **Basics** 標籤：

| 欄位           | 值                                                   |
| -------------- | ---------------------------------------------------- |
| **機器人名稱** | 您的機器人名稱，例如 `openclaw-msteams` （必須唯一） |
| **訂閱**       | 選擇您的 Azure 訂閱                                  |
| **資源群組**   | 創建新資源或使用現有資源                             |
| **定價層級**   | **免費** 用於開發/測試                               |
| **應用類型**   | **單租戶** （建議使用 - 請參見下方註解）             |
| **創建類型**   | **創建新的 Microsoft 應用 ID**                       |

> **棄用通知：** 在 2025-07-31 之後，不再支援創建新的多租戶機器人。請對於新的機器人使用 **單租戶**。

3. 點擊 **檢閱 + 建立** → **建立**（等待約 1-2 分鐘）

### 步驟 2：獲取憑證

1. 前往你的 Azure Bot 資源 → **設定**
2. 複製 **Microsoft App ID** → 這是你的 `appId`
3. 點擊 **管理密碼** → 前往應用程式註冊
4. 在 **憑證與密碼** 下 → **新增用戶端密碼** → 複製 **值** → 這是你的 `appPassword`
5. 前往 **概覽** → 複製 **目錄 (租戶) ID** → 這是你的 `tenantId`

### 步驟 3：設定訊息端點

1. 在 Azure Bot → **設定**
2. 將 **訊息端點** 設定為您的 webhook URL：
   - 生產環境：`https://your-domain.com/api/messages`
   - 本地開發：使用隧道（請參見下方的 [本地開發](#local-development-tunneling)）

### 步驟 4：啟用 Teams 頻道

1. 在 Azure Bot → **頻道**
2. 點擊 **Microsoft Teams** → 設定 → 儲存
3. 接受服務條款

## 本地開發 (隧道)

團隊無法連接到 `localhost`。請使用隧道進行本地開發：

**選項 A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**選項 B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams 開發者入口網站 (替代方案)

您可以使用 [Teams Developer Portal](https://dev.teams.microsoft.com/apps) 來取代手動創建清單 ZIP：

1. 點擊 **+ 新增應用**
2. 填寫基本資訊（名稱、描述、開發者資訊）
3. 前往 **應用功能** → **機器人**
4. 選擇 **手動輸入機器人 ID** 並貼上你的 Azure Bot 應用 ID
5. 檢查範圍：**個人**、**團隊**、**群組聊天**
6. 點擊 **發佈** → **下載應用包**
7. 在 Teams 中：**應用** → **管理你的應用** → **上傳自訂應用** → 選擇 ZIP 檔案

這通常比手動編輯 JSON 清單要容易。

## 測試機器人

**選項 A: Azure Web Chat (先驗證 webhook)**

1. 在 Azure Portal → 你的 Azure Bot 資源 → **在 Web Chat 中測試**
2. 發送一則訊息 - 你應該會看到回應
3. 這確認了你的 webhook 端點在 Teams 設定之前是正常運作的

**選項 B：團隊（安裝應用程式後）**

1. 安裝 Teams 應用程式（側載或組織目錄）
2. 在 Teams 中找到機器人並發送私訊
3. 檢查網關日誌以查看進來的活動

## Setup (minimal text-only)

1. **安裝 Microsoft Teams 外掛**
   - 從 npm: `openclaw plugins install @openclaw/msteams`
   - 從本地檢出: `openclaw plugins install ./extensions/msteams`

2. **機器人註冊**
   - 建立一個 Azure Bot（參見上文）並記下：
     - 應用程式 ID
     - 用戶端密碼（應用程式密碼）
     - 租戶 ID（單租戶）

3. **Teams 應用程式清單**
   - 包含一個 `bot` 專案，並附上 `botId = <App ID>`。
   - 範圍：`personal`、`team`、`groupChat`。
   - `supportsFiles: true`（個人範圍檔案處理所需）。
   - 添加 RSC 權限（如下所示）。
   - 創建圖示：`outline.png`（32x32）和 `color.png`（192x192）。
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

您也可以使用環境變數來替代設定鍵：

- `MSTEAMS_APP_ID`
- `MSTEAMS_APP_PASSWORD`
- `MSTEAMS_TENANT_ID`

5. **機器人端點**
   - 將 Azure Bot 訊息端點設置為：
     - `https://<host>:3978/api/messages`（或您選擇的路徑/端口）。

6. **執行網關**
   - 當插件安裝完成且 `msteams` 設定存在且包含憑證時，Teams 頻道會自動啟動。

## History context

- `channels.msteams.historyLimit` 控制最近多少條頻道/群組消息被包裝進提示中。
- 退回到 `messages.groupChat.historyLimit`。設置 `0` 以禁用（預設為 50）。
- DM 歷史可以通過 `channels.msteams.dmHistoryLimit` 限制（用戶回合）。每位用戶的覆蓋設置：`channels.msteams.dms["<user_id>"].historyLimit`。

## 當前 Teams RSC 權限 (清單)

這些是我們 Teams 應用程式清單中的 **現有資源特定權限**。它們僅適用於安裝應用程式的團隊/聊天內部。

**對於頻道（團隊範圍）：**

- `ChannelMessage.Read.Group` (應用程式) - 接收所有頻道訊息而不需要 @提及
- `ChannelMessage.Send.Group` (應用程式)
- `Member.Read.Group` (應用程式)
- `Owner.Read.Group` (應用程式)
- `ChannelSettings.Read.Group` (應用程式)
- `TeamMember.Read.Group` (應用程式)
- `TeamSettings.Read.Group` (應用程式)

**對於群組聊天：**

- `ChatMessage.Read.Chat` (應用程式) - 接收所有群組聊天訊息而不需要 @提及

## Example Teams Manifest (redacted)

[[BLOCK_1]]  
最小有效範例，包含必要欄位。請替換 ID 和 URL。  
[[BLOCK_1]]

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

### Manifest 注意事項（必填欄位）

- `bots[].botId` **必須** 與 Azure Bot 應用程式 ID 相符。
- `webApplicationInfo.id` **必須** 與 Azure Bot 應用程式 ID 相符。
- `bots[].scopes` 必須包含您計畫使用的表面 (`personal`, `team`, `groupChat`)。
- `bots[].supportsFiles: true` 在個人範圍內處理檔案時是必需的。
- `authorization.permissions.resourceSpecific` 如果您想要通道流量，必須包含通道讀取/發送。

### 更新現有應用程式

要更新已安裝的 Teams 應用程式（例如，添加 RSC 權限）：

1. 更新你的 `manifest.json` 以使用新的設定
2. **增加 `version` 欄位**（例如，`1.0.0` → `1.1.0`）
3. **重新壓縮** 包含圖示的清單（`manifest.json`、`outline.png`、`color.png`）
4. 上傳新的壓縮檔：
   - **選項 A（Teams 管理中心）：** Teams 管理中心 → Teams 應用程式 → 管理應用程式 → 找到你的應用程式 → 上傳新版本
   - **選項 B（側載）：** 在 Teams → 應用程式 → 管理你的應用程式 → 上傳自訂應用程式
5. **對於團隊頻道：** 在每個團隊中重新安裝應用程式以使新權限生效
6. **完全退出並重新啟動 Teams**（不僅僅是關閉視窗）以清除快取的應用程式元資料

## 能力：僅 RSC 與 Graph

### 僅限 **Teams RSC**（已安裝應用程式，無 Graph API 權限）

Works:

- 讀取頻道訊息的 **text** 內容。
- 發送頻道訊息的 **text** 內容。
- 接收 **個人 (DM)** 檔案附件。

Does NOT work:

- 頻道/群組 **圖片或檔案內容**（有效負載僅包含 HTML 樣板）。
- 下載儲存在 SharePoint/OneDrive 的附件。
- 讀取訊息歷史紀錄（超出即時 webhook 事件）。

### 使用 **Teams RSC + Microsoft Graph 應用程式權限**

Adds:

- 下載托管內容（貼在訊息中的圖片）。
- 下載儲存在 SharePoint/OneDrive 的檔案附件。
- 通過 Graph 讀取頻道/聊天訊息歷史記錄。

### RSC 與 Graph API

| 功能           | RSC 權限           | Graph API                   |
| -------------- | ------------------ | --------------------------- |
| **即時訊息**   | 是（透過 webhook） | 否（僅支援輪詢）            |
| **歷史訊息**   | 否                 | 是（可以查詢歷史）          |
| **設置複雜度** | 僅需應用程式清單   | 需要管理員同意 + token 流程 |
| **離線工作**   | 否（必須執行中）   | 是（隨時查詢）              |

**底線：** RSC 用於即時收聽；Graph API 用於歷史存取。要在離線時查看錯過的訊息，您需要 Graph API 和 `ChannelMessage.Read.All`（需要管理員同意）。

## 圖形化媒體 + 歷史（頻道所需）

如果您需要在 **channels** 中使用圖片/檔案或想要獲取 **message history**，您必須啟用 Microsoft Graph 權限並授予管理員同意。

1. 在 Entra ID (Azure AD) **應用程式註冊**中，新增 Microsoft Graph **應用程式權限**：
   - `ChannelMessage.Read.All` (頻道附件 + 歷史記錄)
   - `Chat.Read.All` 或 `ChatMessage.Read.All` (群組聊天)
2. **授予租戶的管理員同意**。
3. 提升 Teams 應用程式的 **清單版本**，重新上傳並 **在 Teams 中重新安裝應用程式**。
4. **完全退出並重新啟動 Teams** 以清除快取的應用程式元資料。

**額外的使用者提及權限：** 使用者 @提及在對話中的使用者可以直接使用。然而，如果您想要動態搜尋並提及**不在當前對話中的**使用者，請添加 `User.Read.All` (應用程式) 權限並授予管理員同意。

## 已知限制事項

### Webhook 超時設定

Teams 透過 HTTP webhook 傳遞訊息。如果處理時間過長（例如，緩慢的 LLM 回應），您可能會看到：

- 閘道超時
- 團隊重試訊息（導致重複）
- 丟失的回覆

OpenClaw 透過快速回傳和主動發送回覆來處理這個問題，但非常緩慢的回應仍可能造成困擾。

### Formatting

Teams 的 Markdown 功能比 Slack 或 Discord 更為有限：

- 基本格式化功能正常：**粗體**、_斜體_、`code`、連結
- 複雜的 Markdown（表格、巢狀列表）可能無法正確顯示
- 支援自適應卡片用於投票和任意卡片發送（見下文）

## Configuration

關鍵設定（請參見 `/gateway/configuration` 以獲取共享頻道模式）：

- `channels.msteams.enabled`: 啟用/停用頻道。
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: 機器人憑證。
- `channels.msteams.webhook.port` (預設 `3978`)
- `channels.msteams.webhook.path` (預設 `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (預設: 配對)
- `channels.msteams.allowFrom`: DM 允許清單 (建議使用 AAD 物件 ID)。當 Graph 存取可用時，精靈在設置過程中會將名稱解析為 ID。
- `channels.msteams.dangerouslyAllowNameMatching`: 破玻璃切換以重新啟用可變 UPN/顯示名稱匹配和直接團隊/頻道名稱路由。
- `channels.msteams.textChunkLimit`: 外發文字塊大小。
- `channels.msteams.chunkMode`: `length` (預設) 或 `newline` 在長度分塊之前根據空白行（段落邊界）進行分割。
- `channels.msteams.mediaAllowHosts`: 進口附件主機的允許清單（預設為 Microsoft/Teams 網域）。
- `channels.msteams.mediaAuthAllowHosts`: 媒體重試時附加授權標頭的允許清單（預設為 Graph + Bot Framework 主機）。
- `channels.msteams.requireMention`: 在頻道/群組中要求 @提及（預設為真）。
- `channels.msteams.replyStyle`: `thread | top-level` (請參見 [回覆樣式](#reply-style-threads-vs-posts))。
- `channels.msteams.teams.<teamId>.replyStyle`: 每個團隊的覆蓋設定。
- `channels.msteams.teams.<teamId>.requireMention`: 每個團隊的覆蓋設定。
- `channels.msteams.teams.<teamId>.tools`: 預設每個團隊工具政策覆蓋 (`allow`/`deny`/`alsoAllow`)，當頻道覆蓋缺失時使用。
- `channels.msteams.teams.<teamId>.toolsBySender`: 預設每個團隊每個發送者的工具政策覆蓋 (`"*"` 支援通配符)。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: 每個頻道的覆蓋設定。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: 每個頻道的覆蓋設定。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: 每個頻道的工具政策覆蓋 (`allow`/`deny`/`alsoAllow`)。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: 每個頻道每個發送者的工具政策覆蓋 (`"*"` 支援通配符)。
- `toolsBySender` 鍵應使用明確的前綴：
  `id:`, `e164:`, `username:`, `name:`（舊版無前綴的鍵仍然僅映射到 `id:`）。
- `channels.msteams.sharePointSiteId`: 用於在群組聊天/頻道中上傳檔案的 SharePoint 網站 ID（請參見 [在群組聊天中發送檔案](#sending-files-in-group-chats)）。

## 路由與會話

- 會話金鑰遵循標準代理格式（請參見 [/concepts/session](/concepts/session)）：
  - 直接消息共享主要會話 (`agent:<agentId>:<mainKey>`)。
  - 頻道/群組消息使用對話 ID：
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 回覆風格：線程 vs 帖子

Teams 最近推出了兩種頻道 UI 風格，基於相同的底層數據模型：

| 樣式                 | 描述                                     | 推薦 `replyStyle` |
| -------------------- | ---------------------------------------- | ----------------- |
| **文章** (經典)      | 訊息以卡片形式顯示，並在下方有串接的回覆 | `thread` (預設)   |
| **串接** (類似Slack) | 訊息以線性方式流動，更像是Slack          | `top-level`       |

**問題：** Teams API 並未公開某個頻道使用的 UI 樣式。如果您使用錯誤的 `replyStyle`：

- `thread` 在 Threads 風格的頻道中 → 回覆顯示得很尷尬地嵌套
- `top-level` 在 Posts 風格的頻道中 → 回覆顯示為獨立的頂層貼文，而不是在主題中

**解決方案：** 根據頻道的設置，為每個頻道設定 `replyStyle`：

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## 附件與圖片

**目前的限制：**

- **DMs:** 圖片和檔案附件透過 Teams 機器人檔案 API 運作。
- **Channels/groups:** 附件儲存在 M365 儲存空間（SharePoint/OneDrive）。Webhook 負載僅包含 HTML 樣板，而不是真正的檔案位元組。**需要 Graph API 權限**才能下載頻道附件。

在沒有 Graph 權限的情況下，頻道中的帶有圖片的訊息將僅以純文字形式接收（機器人無法訪問圖片內容）。  
預設情況下，OpenClaw 只會從 Microsoft/Teams 主機下載媒體。可以使用 `channels.msteams.mediaAllowHosts` 來覆蓋此設定（使用 `["*"]` 以允許任何主機）。  
授權標頭僅會附加到 `channels.msteams.mediaAuthAllowHosts` 中的主機（預設為 Graph + Bot Framework 主機）。請保持此列表的嚴格性（避免多租戶後綴）。

## 在群組聊天中傳送檔案

[[BLOCK_1]] Bots 可以使用 FileConsentCard 流程（內建）在私訊中發送檔案。然而，**在群組聊天/頻道中發送檔案** 需要額外的設定：[[BLOCK_1]]

| 上下文                 | 檔案傳送方式                              | 需要的設定                           |
| ---------------------- | ----------------------------------------- | ------------------------------------ |
| **私訊**               | FileConsentCard → 使用者接受 → 機器人上傳 | 開箱即用                             |
| **群組聊天/頻道**      | 上傳至 SharePoint → 分享連結              | 需要 `sharePointSiteId` + Graph 權限 |
| **圖片（任何上下文）** | Base64 編碼內嵌                           | 開箱即用                             |

### 為什麼群組聊天需要 SharePoint

機器人沒有個人的 OneDrive 磁碟（`/me/drive` Graph API 端點對於應用程式身份無法使用）。要在群組聊天/頻道中傳送檔案，機器人會上傳到 **SharePoint 網站** 並創建共享連結。

### Setup

1. **在 Entra ID (Azure AD) 中新增 Graph API 權限** → 應用程式註冊：
   - `Sites.ReadWrite.All` (應用程式) - 上傳檔案到 SharePoint
   - `Chat.Read.All` (應用程式) - 可選，啟用每位使用者的分享連結

2. **授予租戶的管理員同意**。

3. **獲取您的 SharePoint 網站 ID:**

bash

# 透過 Graph Explorer 或使用有效的 token 進行 curl：

curl -H "Authorization: Bearer $TOKEN" \
 "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

# 範例：對於位於 "contoso.sharepoint.com/sites/BotFiles" 的網站

curl -H "Authorization: Bearer $TOKEN" \
 "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

# 回應包括： "id": "contoso.sharepoint.com,guid1,guid2"

4. **設定 OpenClaw:**

```json5
{
  channels: {
    msteams: {
      // ... other config ...
      sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
    },
  },
}
```

### Sharing behavior

| 權限                                    | 共享行為                                     |
| --------------------------------------- | -------------------------------------------- |
| `Sites.ReadWrite.All` 只有              | 組織範圍的共享連結（組織內任何人都可以訪問） |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 每位使用者的共享連結（只有聊天成員可以訪問） |

每位使用者的共享方式更為安全，因為只有聊天參與者可以訪問該檔案。如果缺少 `Chat.Read.All` 權限，機器人將回退到組織範圍的共享方式。

### Fallback 行為

| 情境                                        | 結果                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| 群組聊天 + 檔案 + `sharePointSiteId` 已設定 | 上傳至 SharePoint，發送分享連結                        |
| 群組聊天 + 檔案 + 無 `sharePointSiteId`     | 嘗試 OneDrive 上傳（可能失敗），僅發送文字             |
| 個人聊天 + 檔案                             | FileConsentCard 流程（在沒有 SharePoint 的情況下運作） |
| 任何情境 + 圖片                             | Base64 編碼的內嵌（在沒有 SharePoint 的情況下運作）    |

### 檔案儲存位置

上傳的檔案儲存在設定的 SharePoint 網站的預設文件庫中的 `/OpenClawShared/` 資料夾內。

## 投票 (自適應卡片)

OpenClaw 透過自適應卡片發送 Teams 投票（目前沒有原生的 Teams 投票 API）。

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- 投票由閘道在 `~/.openclaw/msteams-polls.json` 中記錄。
- 閘道必須保持在線以記錄投票。
- 投票尚未自動發布結果摘要（如有需要，請檢查存儲檔案）。

## Adaptive Cards (任意)

使用 `message` 工具或 CLI 向 Teams 使用者或對話發送任何自適應卡片 JSON。

`card` 參數接受一個自適應卡片 JSON 物件。當 `card` 被提供時，訊息文本是可選的。

**Agent tool:**

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

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

請參閱 [Adaptive Cards documentation](https://adaptivecards.io/) 以獲取卡片架構和範例。欲了解目標格式的詳細資訊，請參見下方的 [Target formats](#target-formats)。

## Target formats

MSTeams 目標使用前綴來區分用戶和對話：

| 目標類型          | 格式                             | 範例                                              |
| ----------------- | -------------------------------- | ------------------------------------------------- |
| 使用者（依 ID）   | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`       |
| 使用者（依名稱）  | `user:<display-name>`            | `user:John Smith`（需要 Graph API）               |
| 群組/頻道         | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`          |
| 群組/頻道（原始） | `<conversation-id>`              | `19:abc123...@thread.tacv2`（如果包含 `@thread`） |

**CLI 範例：**

bash

# 透過 ID 發送訊息給用戶

openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# 透過顯示名稱發送給用戶（觸發 Graph API 查詢）

openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# 發送到群組聊天或頻道

openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "你好"

# 發送自適應卡片到對話

openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
 --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'

**Agent tool examples:**

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
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

注意：若沒有 `user:` 前綴，名稱將預設為群組/團隊解析。針對顯示名稱的時候，請務必使用 `user:`。

## 主動訊息傳遞

- 主動訊息僅在用戶互動後才能發送，因為我們在那時儲存對話參考。
- 請參見 `/gateway/configuration` 以了解 `dmPolicy` 和允許清單閘道。

## 團隊和頻道 ID（常見問題）

The `groupId` 查詢參數在 Teams URL 中是 **NOT** 用於設定的團隊 ID。請從 URL 路徑中提取 ID：

**Team URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**Channel URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**For config:**

- 團隊 ID = `/team/` 之後的路徑段 (URL 解碼，例如 `19:Bk4j...@thread.tacv2`)
- 頻道 ID = `/channel/` 之後的路徑段 (URL 解碼)
- **忽略** `groupId` 查詢參數

## Private Channels

Bots 在私人頻道中的支援有限：

| 功能                | 標準頻道 | 私人頻道         |
| ------------------- | -------- | ---------------- |
| 機器人安裝          | 是       | 有限制           |
| 實時消息（Webhook） | 是       | 可能無法正常運作 |
| RSC 權限            | 是       | 可能有不同的行為 |
| @提及               | 是       | 如果機器人可訪問 |
| Graph API 歷史      | 是       | 是（需具備權限） |

**如果私人頻道無法運作的替代方案：**

1. 使用標準通道進行機器人互動
2. 使用私訊 - 使用者可以隨時直接訊息機器人
3. 使用 Graph API 進行歷史存取（需要 `ChannelMessage.Read.All`）

## 故障排除

### 常見問題

- **頻道中無法顯示圖片：** 可能是因為缺少圖形權限或管理員同意。請重新安裝 Teams 應用程式並完全退出/重新開啟 Teams。
- **頻道中沒有回應：** 預設需要提及；請設置 `channels.msteams.requireMention=false` 或針對每個團隊/頻道進行設定。
- **版本不匹配（Teams 仍顯示舊的清單）：** 請移除並重新添加應用程式，並完全退出 Teams 以刷新。
- **從 webhook 收到 401 未授權：** 在沒有 Azure JWT 的情況下手動測試時預期會出現此情況 - 這意味著端點可達，但身份驗證失敗。請使用 Azure Web Chat 進行正確測試。

### Manifest 上傳錯誤

- **"圖示檔案不能為空":** 清單引用的圖示檔案大小為 0 位元組。請建立有效的 PNG 圖示（`outline.png` 的大小為 32x32，`color.png` 的大小為 192x192）。
- **"webApplicationInfo.Id 已經在使用中":** 該應用程式仍然安裝在其他團隊/聊天中。請先找到並卸載它，或等待 5-10 分鐘以便進行傳播。
- **"上傳時出現問題":** 請改為透過 [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) 上傳，打開瀏覽器的開發者工具 (F12) → 網路標籤，並檢查回應主體以獲取實際錯誤。
- **側載失敗:** 嘗試選擇 "將應用上傳到您組織的應用目錄" 而不是 "上傳自訂應用" - 這通常可以繞過側載限制。

### RSC 權限無法正常運作

1. 確認 `webApplicationInfo.id` 與您的機器人的 App ID 完全一致
2. 重新上傳應用程式並在團隊/聊天中重新安裝
3. 檢查您的組織管理員是否已阻止 RSC 權限
4. 確認您使用的是正確的範圍：`ChannelMessage.Read.Group` 用於團隊，`ChatMessage.Read.Chat` 用於群組聊天

## References

- [建立 Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 設定指南
- [Teams 開發者入口網站](https://dev.teams.microsoft.com/apps) - 創建/管理 Teams 應用程式
- [Teams 應用程式清單架構](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [使用 RSC 接收頻道訊息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC 權限參考](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams 機器人檔案處理](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (頻道/群組需要 Graph)
- [主動訊息傳送](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
