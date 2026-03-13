---
summary: "Google Chat app support status, capabilities, and configuration"
read_when:
  - Working on Google Chat channel features
title: Google Chat
---

# Google Chat (Chat API)

狀態：準備好透過 Google Chat API 網頁鉤子 (僅限 HTTP) 進行直接訊息和空間的互動。

## 快速設置（初學者）

1. 創建一個 Google Cloud 專案並啟用 **Google Chat API**。
   - 前往: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - 如果尚未啟用，請啟用該 API。
2. 創建一個 **Service Account**：
   - 按下 **Create Credentials** > **Service Account**。
   - 隨意命名 (例如，`openclaw-chat`)。
   - 權限留空（按 **Continue**）。
   - 訪問的主體留空（按 **Done**）。
3. 創建並下載 **JSON Key**：
   - 在服務帳戶列表中，點擊剛剛創建的帳戶。
   - 前往 **Keys** 標籤。
   - 點擊 **Add Key** > **Create new key**。
   - 選擇 **JSON** 並按 **Create**。
4. 將下載的 JSON 檔案儲存在你的網關主機上（例如，`~/.openclaw/googlechat-service-account.json`）。
5. 在 [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 中創建一個 Google Chat 應用：
   - 填寫 **Application info**：
     - **App name**: (例如 `OpenClaw`)
     - **Avatar URL**: (例如 `https://openclaw.ai/logo.png`)
     - **Description**: (例如 `Personal AI Assistant`)
   - 啟用 **Interactive features**。
   - 在 **Functionality** 下，勾選 **Join spaces and group conversations**。
   - 在 **Connection settings** 下，選擇 **HTTP endpoint URL**。
   - 在 **Triggers** 下，選擇 **Use a common HTTP endpoint URL for all triggers**，並將其設置為你的網關的公共 URL，後面接上 `/googlechat`。
     - _提示：執行 `openclaw status` 以查找你的網關公共 URL。_
   - 在 **Visibility** 下，勾選 **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**。
   - 在文本框中輸入你的電子郵件地址（例如 `user@example.com`）。
   - 點擊底部的 **Save**。
6. **啟用應用狀態**：
   - 保存後，**刷新頁面**。
   - 尋找 **App status** 區域（通常在保存後的頂部或底部附近）。
   - 將狀態更改為 **Live - available to users**。
   - 再次點擊 **Save**。
7. 使用服務帳戶路徑 + webhook 受眾設定 OpenClaw：
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 或設定: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`。
8. 設置 webhook 受眾類型 + 值（與你的 Chat 應用設定匹配）。
9. 啟動網關。Google Chat 將 POST 到你的 webhook 路徑。

## Add to Google Chat

一旦網關執行並且您的電子郵件已添加到可見性列表中：

1. 前往 [Google Chat](https://chat.google.com/)。
2. 點擊 **+**（加號）圖示，位於 **直接訊息** 旁邊。
3. 在搜尋欄（通常用來新增人員的地方），輸入你在 Google Cloud Console 中設定的 **應用程式名稱**。
   - **注意**：該機器人不會出現在「市場」瀏覽列表中，因為它是一個私人應用程式。你必須透過名稱來搜尋它。
4. 從結果中選擇你的機器人。
5. 點擊 **新增** 或 **聊天** 以開始一對一的對話。
6. 發送「Hello」以觸發助手！

## 公開 URL (僅限 Webhook)

Google Chat 的 webhook 需要一個公開的 HTTPS 端點。為了安全起見，**僅將 `/googlechat` 路徑** 暴露到互聯網上。請將 OpenClaw 儀表板和其他敏感端點保留在您的私人網路中。

### 選項 A: Tailscale Funnel (推薦)

使用 Tailscale Serve 來處理私有儀表板，並使用 Funnel 來處理公開的 webhook 路徑。這樣可以保持 `/` 的私密性，同時僅暴露 `/googlechat`。

1. **檢查你的網關綁定到哪個地址：**

```bash
   ss -tlnp | grep 18789
```

請注意 IP 位址（例如 `127.0.0.1`、`0.0.0.0`，或您的 Tailscale IP，如 `100.x.x.x`）。

2. **僅將儀表板暴露給 tailnet（端口 8443）：**

bash

# 如果綁定到本地主機 (127.0.0.1 或 0.0.0.0):

tailscale serve --bg --https 8443 http://127.0.0.1:18789

# 如果僅綁定到 Tailscale IP（例如，100.106.161.80）：

tailscale serve --bg --https 8443 http://100.106.161.80:18789

3. **僅公開 webhook 路徑：**

bash

# 如果綁定到本地主機 (127.0.0.1 或 0.0.0.0):

tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

# 如果僅綁定到 Tailscale IP（例如，100.106.161.80）：

tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat

4. **授權節點以獲取 Funnel 存取權：**  
   如果出現提示，請訪問輸出中顯示的授權 URL，以在您的 tailnet 政策中為此節點啟用 Funnel。

5. **驗證設定：**

```bash
   tailscale serve status
   tailscale funnel status
```

您的公共 webhook URL 將是：
`https://<node-name>.<tailnet>.ts.net/googlechat`

您的私人儀表板僅限於 tailnet：  
`https://<node-name>.<tailnet>.ts.net:8443/`

在 Google Chat 應用程式設定中使用公共 URL（不包含 `:8443`）。

> 注意：此設定在重啟後仍會保留。若要稍後移除，請執行 `tailscale funnel reset` 和 `tailscale serve reset`。

### 選項 B：反向代理 (Caddy)

如果您使用像 Caddy 這樣的反向代理，僅代理特定的路徑：

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

使用此設定，對 `your-domain.com/` 的任何請求將被忽略或返回 404，而 `your-domain.com/googlechat` 將安全地路由到 OpenClaw。

### 選項 C：Cloudflare 隧道

設定你的隧道的入口規則，以僅路由 webhook 路徑：

- **路徑**: `/googlechat` -> `http://localhost:18789/googlechat`
- **預設規則**: HTTP 404 (未找到)

## 如何運作

1. Google Chat 將 webhook POST 請求發送到網關。每個請求都包含 `Authorization: Bearer <token>` 標頭。
   - 當標頭存在時，OpenClaw 在讀取/解析完整的 webhook 主體之前會驗證 bearer 認證。
   - 包含 `authorizationEventObject.systemIdToken` 的 Google Workspace 附加元件請求透過更嚴格的預認證主體預算來支援。
2. OpenClaw 將 token 與設定的 `audienceType` + `audience` 進行驗證：
   - `audienceType: "app-url"` → 受眾是您的 HTTPS webhook URL。
   - `audienceType: "project-number"` → 受眾是雲端專案編號。
3. 訊息依空間路由：
   - 直接訊息 (DM) 使用會話金鑰 `agent:<agentId>:googlechat:dm:<spaceId>`。
   - 空間使用會話金鑰 `agent:<agentId>:googlechat:group:<spaceId>`。
4. DM 存取預設為配對。未知發送者會收到配對程式碼；請使用以下方式批准：
   - `openclaw pairing approve googlechat <code>`
5. 群組空間預設需要 @-提及。如果提及檢測需要應用程式的使用者名稱，請使用 `botUser`。

## Targets

使用這些識別碼進行交付和白名單：

- 直接訊息: `users/<userId>`（推薦）。
- 原始電子郵件 `name@example.com` 是可變的，僅用於在 `channels.googlechat.dangerouslyAllowNameMatching: true` 時進行直接的允許清單匹配。
- 已淘汰: `users/<email>` 被視為用戶 ID，而非電子郵件允許清單。
- 空格: `spaces/<spaceId>`。

## Config highlights

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      // or serviceAccountRef: { source: "file", provider: "filemain", id: "/channels/googlechat/serviceAccount" }
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

[[BLOCK_1]]

- 服務帳戶憑證也可以通過 `serviceAccount` 直接傳遞（JSON 字串）。
- `serviceAccountRef` 也受到支援（環境變數/檔案 SecretRef），包括在 `channels.googlechat.accounts.<id>.serviceAccountRef` 下的每個帳戶引用。
- 預設的 webhook 路徑是 `/googlechat`，如果 `webhookPath` 沒有設定的話。
- `dangerouslyAllowNameMatching` 重新啟用可變電子郵件主體匹配以供允許清單使用（緊急情況相容模式）。
- 當 `actions.reactions` 被啟用時，可以通過 `reactions` 工具和 `channels action` 獲得反應。
- `typingIndicator` 支援 `none`、`message`（預設）和 `reaction`（反應需要用戶 OAuth）。
- 附件通過 Chat API 下載並儲存在媒體管道中（大小受 `mediaMaxMb` 限制）。

Secrets 參考詳細資訊：[Secrets Management](/gateway/secrets)。

## 故障排除

### 405 方法不被允許

如果 Google Cloud Logs Explorer 顯示錯誤，例如：

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

這表示 webhook 處理程序尚未註冊。常見原因：

1. **頻道未設定**：您的設定中缺少 `channels.googlechat` 區段。請確認：

```bash
   openclaw config get channels.googlechat
```

如果返回「找不到設定路徑」，請添加設定（請參見 [Config highlights](#config-highlights)）。

2. **插件未啟用**：檢查插件狀態：

```bash
   openclaw plugins list | grep googlechat
```

如果顯示為「已禁用」，請將 `plugins.entries.googlechat.enabled: true` 添加到您的設定中。

3. **閘道器未重新啟動**：在添加設定後，請重新啟動閘道器：

```bash
   openclaw gateway restart
```

確認頻道是否正在執行：

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### 其他問題

- 檢查 `openclaw channels status --probe` 以確認是否有認證錯誤或缺少受眾設定。
- 如果沒有消息到達，請確認聊天應用的 webhook URL 和事件訂閱。
- 如果提及限制阻止回覆，將 `botUser` 設定為應用的用戶資源名稱並驗證 `requireMention`。
- 在發送測試消息時使用 `openclaw logs --follow` 以查看請求是否到達網關。

[[BLOCK_1]]

- [閘道器設定](/gateway/configuration)
- [安全性](/gateway/security)
- [反應](/tools/reactions)
