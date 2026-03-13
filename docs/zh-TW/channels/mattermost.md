---
summary: Mattermost bot setup and OpenClaw config
read_when:
  - Setting up Mattermost
  - Debugging Mattermost routing
title: Mattermost
---

# Mattermost (插件)

狀態：透過插件支援（機器人 token + WebSocket 事件）。支援頻道、群組和直接訊息（DM）。

Mattermost 是一個可自我託管的團隊訊息平台；有關產品詳細資訊和下載，請參閱官方網站 [mattermost.com](https://mattermost.com)。

## 需要插件

Mattermost 作為一個插件發佈，並不與核心安裝包捆綁在一起。

透過 CLI 安裝（npm 註冊表）：

```bash
openclaw plugins install @openclaw/mattermost
```

[[BLOCK_1]]  
本地檢出（當從 git 倉庫執行時）：  
[[BLOCK_1]]

```bash
openclaw plugins install ./extensions/mattermost
```

如果您在設定/入門時選擇了 Mattermost，並且檢測到 git checkout，OpenClaw 將自動提供本地安裝路徑。

[[INLINE_1]]

## 快速設定

1. 安裝 Mattermost 外掛。
2. 創建一個 Mattermost 機器人帳號並複製 **bot token**。
3. 複製 Mattermost **base URL**（例如，`https://chat.example.com`）。
4. 設定 OpenClaw 並啟動網關。

[[BLOCK_1]]  
最小設定：  
[[BLOCK_1]]

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## 原生斜線指令

原生斜線命令是選擇性啟用的。當啟用後，OpenClaw 透過 Mattermost API 註冊 `oc_*` 斜線命令，並在網關 HTTP 伺服器上接收回調 POST 請求。

```json5
{
  channels: {
    mattermost: {
      commands: {
        native: true,
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // Use when Mattermost cannot reach the gateway directly (reverse proxy/public URL).
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
    },
  },
}
```

Notes:

- `native: "auto"` 預設為禁用狀態，請設定 `native: true` 以啟用。
- 如果省略 `callbackUrl`，OpenClaw 將從網關主機/端口 + `callbackPath` 推導出一個。
- 對於多帳戶設置，`commands` 可以在頂層或在 `channels.mattermost.accounts.<id>.commands` 下設定（帳戶值會覆蓋頂層欄位）。
- 命令回調會使用每個命令的 token 進行驗證，當 token 檢查失敗時會關閉。
- 可達性要求：回調端點必須能從 Mattermost 伺服器訪問。
  - 除非 Mattermost 與 OpenClaw 在同一主機/網路命名空間上，否則請勿將 `callbackUrl` 設定為 `localhost`。
  - 除非該 URL 反向代理 `/api/channels/mattermost/command` 到 OpenClaw，否則請勿將 `callbackUrl` 設定為你的 Mattermost 基本 URL。
  - 快速檢查是 `curl https://<gateway-host>/api/channels/mattermost/command`；一個 GET 請求應該從 OpenClaw 返回 `405 Method Not Allowed`，而不是 `404`。
- Mattermost 外發允許清單要求：
  - 如果你的回調目標是私有/尾網/內部地址，請將 Mattermost `ServiceSettings.AllowedUntrustedInternalConnections` 設定為包含回調主機/域名。
  - 使用主機/域名條目，而不是完整的 URL。
    - 好的: `gateway.tailnet-name.ts.net`
    - 不好的: `https://gateway.tailnet-name.ts.net`

## 環境變數（預設帳戶）

如果您偏好使用環境變數，請在閘道主機上設置這些：

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

環境變數僅適用於 **預設** 帳戶 (`default`). 其他帳戶必須使用設定值。

## 聊天模式

Mattermost 自動回應私訊。頻道行為由 `chatmode` 控制：

- `oncall` (預設): 只有在頻道中被 @提及時才回應。
- `onmessage`: 對每條頻道訊息都回應。
- `onchar`: 當訊息以觸發前綴開頭時回應。

Config example:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

[[BLOCK_1]]

- `onchar` 仍然會對明確的 @提及做出回應。
- `channels.mattermost.requireMention` 在舊版設定中仍然有效，但 `chatmode` 是首選。

## Threading 和會話

使用 `channels.mattermost.replyToMode` 來控制頻道和群組的回覆是保持在主頻道中，還是開始在觸發貼文下的線程中。

- `off` (預設): 只有在進入的貼文已經在一個線程中時，才會在該線程中回覆。
- `first`: 對於頂層頻道/群組貼文，在該貼文下開始一個線程，並將對話引導至線程範圍的會話。
- `all`: 對於今天的 Mattermost，行為與 `first` 相同。
- 直接訊息忽略此設定，並保持非線程狀態。

Config example:

```json5
{
  channels: {
    mattermost: {
      replyToMode: "all",
    },
  },
}
```

[[BLOCK_1]]

- 線程範圍的會話使用觸發的貼文 ID 作為線程根。
- `first` 和 `all` 目前是等價的，因為一旦 Mattermost 有了線程根，後續的區塊和媒體將繼續在同一個線程中進行。

## 存取控制 (DMs)

- 預設: `channels.mattermost.dmPolicy = "pairing"` (未知發送者會獲得配對碼)。
- 批准方式：
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公開私訊: `channels.mattermost.dmPolicy="open"` 加上 `channels.mattermost.allowFrom=["*"]`。

## Channels (groups)

- 預設: `channels.mattermost.groupPolicy = "allowlist"` (提及限制)。
- 允許清單發送者使用 `channels.mattermost.groupAllowFrom` (建議使用用戶 ID)。
- `@username` 匹配是可變的，並且僅在 `channels.mattermost.dangerouslyAllowNameMatching: true` 時啟用。
- 開放頻道: `channels.mattermost.groupPolicy="open"` (提及限制)。
- 執行時注意: 如果 `channels.mattermost` 完全缺失，執行時將回退到 `groupPolicy="allowlist"` 進行群組檢查 (即使 `channels.defaults.groupPolicy` 已設置)。

## 出貨目標

使用這些目標格式與 `openclaw message send` 或 cron/webhooks：

- `channel:<id>` 用於頻道
- `user:<id>` 用於直接訊息
- `@username` 用於直接訊息（透過 Mattermost API 解決）

裸露的不透明 ID（如 `64ifufp...`）在 Mattermost 中是**模糊的**（用戶 ID 與頻道 ID）。

OpenClaw 以 **用戶為先** 的方式解決這些問題：

- 如果該 ID 存在為用戶 (`GET /api/v4/users/<id>` 成功)，OpenClaw 會透過 `/api/v4/channels/direct` 解決直接通道並發送 **DM**。
- 否則，該 ID 將被視為 **頻道 ID**。

如果您需要確定性行為，請始終使用明確的前綴 (`user:<id>` / `channel:<id>`)。

## Reactions (訊息工具)

- 使用 `message action=react` 與 `channel=mattermost`。
- `messageId` 是 Mattermost 的貼文 ID。
- `emoji` 接受像 `thumbsup` 或 `:+1:` 的名稱（冒號是可選的）。
- 設定 `remove=true`（布林值）以移除反應。
- 反應的新增/移除事件會作為系統事件轉發到路由的代理會話。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

Config:

- `channels.mattermost.actions.reactions`: 啟用/禁用反應動作（預設為 true）。
- 每個帳戶的覆蓋設定: `channels.mattermost.accounts.<id>.actions.reactions`。

## 互動按鈕 (訊息工具)

發送帶有可點擊按鈕的訊息。當用戶點擊按鈕時，代理會接收到該選擇並可以進行回應。

透過將 `inlineButtons` 添加到頻道功能來啟用按鈕：

```json5
{
  channels: {
    mattermost: {
      capabilities: ["inlineButtons"],
    },
  },
}
```

使用 `message action=send` 並搭配 `buttons` 參數。按鈕是一個二維陣列（按鈕的行）：

```
message action=send channel=mattermost target=channel:<channelId> buttons=[[{"text":"Yes","callback_data":"yes"},{"text":"No","callback_data":"no"}]]
```

Button fields:

- `text` (必填): 顯示標籤。
- `callback_data` (必填): 點擊時回傳的值 (用作動作 ID)。
- `style` (選填): `"default"`、`"primary"` 或 `"danger"`。

當使用者點擊按鈕：

1. 所有按鈕都被替換為確認行（例如，「✓ **是** 由 @user 選擇」）。
2. 代理接收選擇作為進來的訊息並作出回應。

[[BLOCK_1]]

- 按鈕回調使用 HMAC-SHA256 驗證（自動，無需設定）。
- Mattermost 從其 API 回應中刪除回調資料（安全功能），因此所有按鈕在點擊時會被移除 — 無法部分移除。
- 包含連字符或底線的動作 ID 會自動進行清理（Mattermost 路由限制）。

Config:

- `channels.mattermost.capabilities`: 能力字串的陣列。新增 `"inlineButtons"` 以啟用代理系統提示中的按鈕工具描述。
- `channels.mattermost.interactions.callbackBaseUrl`: 按鈕回調的可選外部基本 URL（例如 `https://gateway.example.com`）。當 Mattermost 無法直接訪問其綁定主機上的網關時，使用此選項。
- 在多帳戶設置中，您也可以在 `channels.mattermost.accounts.<id>.interactions.callbackBaseUrl` 下設置相同的欄位。
- 如果省略 `interactions.callbackBaseUrl`，OpenClaw 將從 `gateway.customBindHost` + `gateway.port` 派生回調 URL，然後回退到 `http://localhost:<port>`。
- 可達性規則：按鈕回調 URL 必須能從 Mattermost 伺服器訪問。`localhost` 只有在 Mattermost 和 OpenClaw 執行在同一主機/網路命名空間時才有效。
- 如果您的回調目標是私有的/tailnet/內部，請將其主機/域名添加到 Mattermost `ServiceSettings.AllowedUntrustedInternalConnections`。

### 直接 API 整合（外部腳本）

外部腳本和網路鉤子可以直接透過 Mattermost REST API 發送按鈕，而不必經過代理的 `message` 工具。當可能時，請使用擴充功能中的 `buildButtonAttachments()`；如果發送原始 JSON，請遵循以下規則：

**Payload 結構：**

```json5
{
  channel_id: "<channelId>",
  message: "Choose an option:",
  props: {
    attachments: [
      {
        actions: [
          {
            id: "mybutton01", // alphanumeric only — see below
            type: "button", // required, or clicks are silently ignored
            name: "Approve", // display label
            style: "primary", // optional: "default", "primary", "danger"
            integration: {
              url: "https://gateway.example.com/mattermost/interactions/default",
              context: {
                action_id: "mybutton01", // must match button id (for name lookup)
                action: "approve",
                // ... any custom fields ...
                _token: "<hmac>", // see HMAC section below
              },
            },
          },
        ],
      },
    ],
  },
}
```

**關鍵規則：**

1. 附件應放在 `props.attachments`，而不是頂層的 `attachments`（會被靜默忽略）。
2. 每個動作都需要 `type: "button"` — 沒有它，點擊會被靜默吞噬。
3. 每個動作都需要一個 `id` 欄位 — Mattermost 會忽略沒有 ID 的動作。
4. 動作 `id` 必須是 **僅限字母數字** (`[a-zA-Z0-9]`)。連字號和底線會破壞 Mattermost 的伺服器端動作路由（返回 404）。使用前請去除它們。
5. `context.action_id` 必須與按鈕的 `id` 匹配，以便確認訊息顯示按鈕名稱（例如，“批准”）而不是原始 ID。
6. `context.action_id` 是必需的 — 互動處理器在沒有它的情況下會返回 400。

**HMAC token 生成：**

閘道器使用 HMAC-SHA256 驗證按鈕點擊。外部腳本必須生成與閘道器驗證邏輯相符的 token：

1. 從機器人token中推導出密鑰：
   `HMAC-SHA256(key="openclaw-mattermost-interactions", data=botToken)`
2. 建立包含所有欄位的上下文物件 **但不包括** `_token`。
3. 使用 **排序的鍵** 和 **無空格** 進行序列化（網關使用 `JSON.stringify` 進行排序鍵，這會產生緊湊的輸出）。
4. 簽名： `HMAC-SHA256(key=secret, data=serializedContext)`
5. 將結果的十六進位摘要作為 `_token` 添加到上下文中。

[[BLOCK_1]]  
Python 範例：  
[[BLOCK_2]]

python
import hmac, hashlib, json

secret = hmac.new(
b"openclaw-mattermost-interactions",
bot_token.encode(), hashlib.sha256
).hexdigest()

ctx = {"action_id": "mybutton01", "action": "approve"}
payload = json.dumps(ctx, sort_keys=True, separators=(",", ":"))
token = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

context = {\*\*ctx, "\_token": token}

常見的 HMAC 陷阱：

- Python 的 `json.dumps` 預設會添加空格 (`{"key": "val"}`)。使用 `separators=(",", ":")` 來匹配 JavaScript 的緊湊輸出 (`{"key":"val"}`)。
- 總是簽署 **所有** 上下文欄位（不包括 `_token`）。閘道會去除 `_token`，然後簽署剩下的所有內容。簽署子集會導致靜默驗證失敗。
- 使用 `sort_keys=True` — 閘道在簽署之前會對鍵進行排序，而 Mattermost 在儲存有效負載時可能會重新排序上下文欄位。
- 從機器人 token 派生秘密（確定性），而不是隨機位元組。秘密必須在創建按鈕的過程和驗證的閘道之間保持一致。

## 目錄適配器

Mattermost 插件包含一個目錄適配器，通過 Mattermost API 解析頻道和用戶名稱。這使得 `#channel-name` 和 `@username` 目標能夠在 `openclaw message send` 和 cron/webhook 傳遞中使用。

不需要任何設定 — 該適配器使用帳戶設定中的機器人 token。

## Multi-account

Mattermost 支援在 `channels.mattermost.accounts` 下的多個帳戶：

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## 故障排除

- 頻道中沒有回覆：確保機器人已在頻道中並提及它（oncall），使用觸發前綴（onchar），或設置 `chatmode: "onmessage"`。
- 認證錯誤：檢查機器人 token、基本 URL，以及帳戶是否已啟用。
- 多帳戶問題：環境變數僅適用於 `default` 帳戶。
- 按鈕顯示為白色方塊：代理可能正在發送格式錯誤的按鈕數據。檢查每個按鈕是否都有 `text` 和 `callback_data` 欄位。
- 按鈕渲染但點擊無效：確認 `AllowedUntrustedInternalConnections` 在 Mattermost 伺服器設定中包含 `127.0.0.1 localhost`，並且 `EnablePostActionIntegration` 在 ServiceSettings 中為 `true`。
- 點擊按鈕返回 404：按鈕 `id` 可能包含連字符或底線。Mattermost 的動作路由器在非字母數字 ID 上會出錯。僅使用 `[a-zA-Z0-9]`。
- 閘道日誌 `invalid _token`：HMAC 不匹配。檢查您是否簽署所有上下文字段（而不是子集），使用排序的鍵，並使用緊湊的 JSON（無空格）。請參見上面的 HMAC 部分。
- 閘道日誌 `missing _token in context`：`_token` 欄位不在按鈕的上下文中。確保在構建整合有效負載時包含它。
- 確認顯示原始 ID 而不是按鈕名稱：`context.action_id` 與按鈕的 `id` 不匹配。將兩者設置為相同的已清理值。
- 代理不知道按鈕：將 `capabilities: ["inlineButtons"]` 添加到 Mattermost 頻道設定中。
