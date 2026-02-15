---
summary: "Google Chat 應用程式支援狀態、功能與設定"
read_when:
  - 處理 Google Chat 頻道功能時
title: "Google Chat"
---

# Google Chat (Chat API)

狀態：透過 Google Chat API webhook（僅限 HTTP）支援私訊 + 空間。

## 快速設定 (初學者)

1. 建立 Google Cloud 專案並啟用 **Google Chat API**。
   - 前往：[Google Chat API 憑證](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - 如果尚未啟用，請啟用 API。
2. 建立**服務帳戶**：
   - 點擊**建立憑證** > **服務帳戶**。
   - 將其命名為您想要的名稱（例如，`openclaw-chat`）。
   - 將權限留空（點擊**繼續**）。
   - 將具有存取權的主體留空（點擊**完成**）。
3. 建立並下載 **JSON 金鑰**：
   - 在服務帳戶清單中，點擊您剛才建立的帳戶。
   - 前往**金鑰**分頁。
   - 點擊**新增金鑰** > **建立新金鑰**。
   - 選擇 **JSON** 並點擊**建立**。
4. 將下載的 JSON 檔案儲存在您的 Gateway 主機上（例如，`~/.openclaw/googlechat-service-account.json`）。
5. 在 [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 中建立 Google Chat 應用程式：
   - 填寫**應用程式資訊**：
     - **應用程式名稱**：(例如 `OpenClaw`)
     - **頭像網址**：(例如 `https://openclaw.ai/logo.png`)
     - **描述**：(例如 `Personal AI Assistant`)
   - 啟用**互動功能**。
   - 在**功能**下，勾選**加入空間和群組對話**。
   - 在**連線設定**下，選擇 **HTTP 端點 URL**。
   - 在**觸發器**下，選擇**為所有觸發器使用通用的 HTTP 端點 URL**，並將其設定為您的 Gateway 的公開 URL，後面加上 `/googlechat`。
     - _提示：執行 `openclaw status` 以找到您的 Gateway 的公開 URL。_
   - 在**可見性**下，勾選**讓此聊天應用程式可供 <您的網域> 中的特定人員和群組使用**。
   - 在文字方塊中輸入您的電子郵件地址（例如 `user@example.com`）。
   - 點擊底部的**儲存**。
6. **啟用應用程式狀態**：
   - 儲存後，**重新整理頁面**。
   - 尋找**應用程式狀態**區段（通常在儲存後位於頂部或底部附近）。
   - 將狀態變更為**上線中 - 對使用者可用**。
   - 再次點擊**儲存**。
7. 使用服務帳戶路徑 + webhook 受眾設定 OpenClaw：
   - 環境變數：`GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 或設定：`channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`。
8. 設定 webhook 受眾類型 + 值（與您的 Chat 應用程式設定相符）。
9. 啟動 Gateway。Google Chat 將 POST 到您的 webhook 路徑。

## 新增到 Google Chat

一旦 Gateway 正在執行且您的電子郵件已新增至可見性清單：

1. 前往 [Google Chat](https://chat.google.com/)。
2. 點擊**私訊**旁的 `+`（加號）圖示。
3. 在搜尋列中（您通常新增人員的地方），輸入您在 Google Cloud Console 中設定的**應用程式名稱**。
   - **注意**：該機器人將不會出現在「市集」瀏覽清單中，因為它是私有應用程式。您必須依名稱搜尋它。
4. 從結果中選擇您的機器人。
5. 點擊**新增**或**聊天**以開始一對一對話。
6. 傳送「Hello」以觸發助理！

## 公開 URL (僅限 Webhook)

Google Chat webhook 需要一個公開的 HTTPS 端點。為了安全起見，**僅將 `/googlechat` 路徑公開**到網際網路。將 OpenClaw 儀表板和其他敏感端點保留在您的私人網路中。

### 選項 A：Tailscale Funnel (推薦)

使用 Tailscale Serve 用於私人儀表板，並使用 Funnel 用於公開 webhook 路徑。這使得 `/` 保持私有，同時僅公開 `/googlechat`。

1. **檢查您的 Gateway 綁定到哪個位址：**

   ```bash
   ss -tlnp | grep 18789
   ```

   記下 IP 位址（例如，`127.0.0.1`、`0.0.0.0`，或您的 Tailscale IP，例如 `100.x.x.x`）。

2. **僅將儀表板公開給 tailnet（連接埠 8443）：**

   ```bash
   # 如果綁定到 localhost (127.0.0.1 或 0.0.0.0)：
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # 如果僅綁定到 Tailscale IP (例如，100.106.161.80)：
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **僅公開 webhook 路徑：**

   ```bash
   # 如果綁定到 localhost (127.0.0.1 或 0.0.0.0)：
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # 如果僅綁定到 Tailscale IP (例如，100.106.161.80)：
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **授權節點進行 Funnel 存取：**
   如果出現提示，請造訪輸出中顯示的授權 URL，以在您的 tailnet 策略中啟用此節點的 Funnel。

5. **驗證設定：**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

您的公開 webhook URL 將為：
`https://<node-name>.<tailnet>.ts.net/googlechat`

您的私人儀表板僅限 tailnet 存取：
`https://<node-name>.<tailnet>.ts.net:8443/`

在 Google Chat 應用程式設定中，使用公開 URL（不含 `:8443`）。

> 注意：此設定會在重新啟動後保持不變。若要稍後移除它，請執行 `tailscale funnel reset` 和 `tailscale serve reset`。

### 選項 B：反向代理 (Caddy)

如果您使用像 Caddy 這樣的反向代理，請僅代理特定路徑：

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

透過此設定，任何對 `your-domain.com/` 的請求將被忽略或返回 404，而 `your-domain.com/googlechat` 則安全地路由到 OpenClaw。

### 選項 C：Cloudflare 通道

設定您的通道的入口規則以僅路由 webhook 路徑：

- **路徑**：`/googlechat` -> `http://localhost:18789/googlechat`
- **預設規則**：HTTP 404 (未找到)

## 運作方式

1. Google Chat 向 Gateway 傳送 webhook POST 請求。每個請求都包含一個 `Authorization: Bearer <token>` 標頭。
2. OpenClaw 根據設定的 `audienceType` + `audience` 驗證權杖：
   - `audienceType: "app-url"` → 受眾是您的 HTTPS webhook URL。
   - `audienceType: "project-number"` → 受眾是 Cloud 專案編號。
3. 訊息按空間路由：
   - 私訊使用工作階段鍵 `agent:<agentId>:googlechat:dm:<spaceId>`。
   - 空間使用工作階段鍵 `agent:<agentId>:googlechat:group:<spaceId>`。
4. 私訊存取預設為配對。未知寄件者會收到配對碼；批准方式為：
   - `openclaw pairing approve googlechat <code>`
5. 群組空間預設需要 @提及。如果提及偵測需要應用程式的使用者名稱，請使用 `botUser`。

## 目標

使用這些識別碼用於傳遞和允許清單：

- 私訊：`users/<userId>` 或 `users/<email>`（接受電子郵件地址）。
- 空間：`spaces/<spaceId>`。

## 設定重點

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name @example.com"],
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

備註：

- 服務帳戶憑證也可以透過 `serviceAccount`（JSON 字串）內聯傳遞。
- 如果未設定 `webhookPath`，則預設 webhook 路徑為 `/googlechat`。
- 當 `actions.reactions` 啟用時，可透過 `reactions` 工具和 `channels action` 使用回應。
- `typingIndicator` 支援 `none`、`message`（預設）和 `reaction`（回應需要使用者 OAuth）。
- 附件透過 Chat API 下載並儲存在媒體管道中（大小上限為 `mediaMaxMb`）。

## 疑難排解

### 405 不允許的方法 (Method Not Allowed)

如果 Google Cloud Logs Explorer 顯示如下錯誤：

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

這表示 webhook 處理常式未註冊。常見原因：

1. **頻道未設定**：您的設定中缺少 `channels.googlechat` 部分。請使用以下方式驗證：

   ```bash
   openclaw config get channels.googlechat
   ```

   如果它返回「Config path not found」，請新增設定（請參閱[設定重點](#config-highlights)）。

2. **外掛程式未啟用**：檢查外掛程式狀態：

   ```bash
   openclaw plugins list | grep googlechat
   ```

   如果它顯示「disabled」，請將 `plugins.entries.googlechat.enabled: true` 新增到您的設定中。

3. **Gateway 未重新啟動**：新增設定後，重新啟動 Gateway：

   ```bash
   openclaw gateway restart
   ```

驗證頻道是否正在執行：

```bash
openclaw channels status
# 應該顯示：Google Chat default: enabled, configured, ...
```

### 其他問題

- 檢查 `openclaw channels status --probe` 以了解驗證錯誤或缺少受眾設定。
- 如果沒有訊息到達，請確認 Chat 應用程式的 webhook URL + 事件訂閱。
- 如果提及閘門阻止回覆，請將 `botUser` 設定為應用程式的使用者資源名稱並驗證 `requireMention`。
- 在傳送測試訊息時使用 `openclaw logs --follow` 以查看請求是否到達 Gateway。

相關文件：

- [Gateway 設定](/gateway/configuration)
- [安全性](/gateway/security)
- [回應](/tools/reactions)
