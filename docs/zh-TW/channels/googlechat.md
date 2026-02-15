---
summary: "Google Chat 應用程式支援狀態、功能與設定"
read_when:
  - 處理 Google Chat 頻道功能時
title: "Google Chat"
---

<!-- markdownlint-disable MD049 -->

# Google Chat (Chat API)

狀態：已就緒，可透過 Google Chat API webhook（僅限 HTTP）支援私訊與空間。

## 快速設定（初學者）

1. 建立 Google Cloud 專案並啟用 **Google Chat API**。
   - 前往：[Google Chat API 憑證](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - 若尚未啟用，請啟用該 API。
2. 建立**服務帳戶（Service Account）**：
   - 點選**建立憑證** > **服務帳戶**。
   - 隨意命名（例如 `openclaw-chat`）。
   - 權限保持空白（點選**繼續**）。
   - 存取權限的主體保持空白（點選**完成**）。
3. 建立並下載 **JSON 金鑰**：
   - 在服務帳戶清單中，點選您剛剛建立的帳戶。
   - 前往**金鑰**分頁。
   - 點選**新增金鑰** > **建立新金鑰**。
   - 選擇 **JSON** 並點選**建立**。
4. 將下載的 JSON 檔案儲存在您的 Gateway 主機上（例如 `~/.openclaw/googlechat-service-account.json`）。
5. 在 [Google Cloud Console Chat 設定](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)中建立 Google Chat 應用程式：
   - 填寫**應用程式資訊**：
     - **應用程式名稱**：（例如 `OpenClaw`）
     - **大頭照 URL**：（例如 `https://openclaw.ai/logo.png`）
     - **說明**：（例如 `Personal AI Assistant`）
   - 啟用**互動功能**。
   - 在**功能（Functionality）**下，勾選**加入空間和群組對話**。
   - 在**連線設定（Connection settings）**下，選擇 **HTTP 端點 URL**。
   - 在**觸發條件（Triggers）**下，選擇**為所有觸發條件使用共同的 HTTP 端點 URL**，並將其設定為您的 Gateway 公用 URL 後面加上 `/googlechat`。
     - _提示：執行 `openclaw status` 以尋找您的 Gateway 公用 URL。_
   - 在**公開範圍（Visibility）**下，勾選**讓此 Chat 應用程式可供 <您的網域> 中的特定對象和群組使用**。
   - 在文字框中輸入您的電子郵件地址（例如 `user@example.com`）。
   - 點選底部的**儲存**。
6. **啟用應用程式狀態**：
   - 儲存後，**重新整理頁面**。
   - 尋找**應用程式狀態（App status）**區塊（通常在儲存後出現在頂部或底部）。
   - 將狀態更改為**已上線 - 可供使用者使用（Live - available to users）**。
   - 再次點選**儲存**。
7. 使用服務帳戶路徑 + webhook audience 設定 OpenClaw：
   - 環境變數：`GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 或設定檔案：`channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`。
8. 設定 webhook audience 類型與值（須與您的 Chat 應用程式設定相符）。
9. 啟動 Gateway。Google Chat 將會 POST 到您的 webhook 路徑。

## 新增至 Google Chat

當 Gateway 正在執行且您的電子郵件已新增至公開範圍清單後：

1. 前往 [Google Chat](https://chat.google.com/)。
2. 點選**私訊**旁的 **+**（加號）圖示。
3. 在搜尋列（通常用於新增聯絡人的地方），輸入您在 Google Cloud Console 中設定的**應用程式名稱**。
   - **注意**：由於這是一個私人應用程式，機器人會*不*出現在「Marketplace」瀏覽清單中。您必須透過名稱搜尋。
4. 從結果中選擇您的機器人。
5. 點選**新增**或**聊天**以開始 1:1 對話。
6. 發送「Hello」來觸發智慧代理！

## 公用 URL（僅限 Webhook）

Google Chat webhook 需要一個公用的 HTTPS 端點。為了安全起見，**請僅將 `/googlechat` 路徑暴露**於網際網路。請將 OpenClaw 儀表板和其他敏感端點保留在您的私人網路中。

### 選項 A：Tailscale Funnel（推薦）

使用 Tailscale Serve 處理私人儀表板，並使用 Funnel 處理公用 webhook 路徑。這能讓 `/` 保持私有，同時僅暴露 `/googlechat`。

1. **檢查您的 Gateway 綁定到哪個位址：**

   ```bash
   ss -tlnp | grep 18789
   ```

   請記下 IP 位址（例如 `127.0.0.1`、`0.0.0.0` 或您的 Tailscale IP 如 `100.x.x.x`）。

2. **僅向 tailnet 暴露儀表板（連接埠 8443）：**

   ```bash
   # 若綁定到 localhost (127.0.0.1 或 0.0.0.0)：
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # 若僅綁定到 Tailscale IP (例如 100.106.161.80)：
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **僅公開暴露 webhook 路徑：**

   ```bash
   # 若綁定到 localhost (127.0.0.1 或 0.0.0.0)：
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # 若僅綁定到 Tailscale IP (例如 100.106.161.80)：
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **授權節點進行 Funnel 存取：**
   如果出現提示，請造訪輸出中顯示的授權 URL，以便在您的 tailnet 政策中為此節點啟用 Funnel。

5. **驗證設定：**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

您的公用 webhook URL 將為：
`https://<node-name>.<tailnet>.ts.net/googlechat`

您的私人儀表板仍僅限 tailnet 存取：
`https://<node-name>.<tailnet>.ts.net:8443/`

在 Google Chat 應用程式設定中使用公用 URL（不含 `:8443`）。

> 注意：此設定在重新開機後仍會保留。如需後續移除，請執行 `tailscale funnel reset` 與 `tailscale serve reset`。

### 選項 B：反向代理（Caddy）

如果您使用像 Caddy 這樣的反向代理，請僅代理特定路徑：

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

使用此設定，任何對 `your-domain.com/` 的請求都將被忽略或返回 404，而 `your-domain.com/googlechat` 則會安全地路由到 OpenClaw。

### 選項 C：Cloudflare Tunnel

設定您通道的進入規則（ingress rules），使其僅路由 webhook 路徑：

- **路徑**：`/googlechat` -> `http://localhost:18789/googlechat`
- **預設規則**：HTTP 404 (Not Found)

## 運作原理

1. Google Chat 會向 Gateway 發送 webhook POST 請求。每個請求都包含一個 `Authorization: Bearer <token>` 標頭。
2. OpenClaw 會根據設定的 `audienceType` + `audience` 驗證權杖：
   - `audienceType: "app-url"` → audience 是您的 HTTPS webhook URL。
   - `audienceType: "project-number"` → audience 是 Cloud 專案編號。
3. 訊息按空間路由：
   - 私訊使用工作階段金鑰 `agent:<agentId>:googlechat:dm:<spaceId>`。
   - 空間使用工作階段金鑰 `agent:<agentId>:googlechat:group:<spaceId>`。
4. 私訊存取預設為配對模式。未知的發送者會收到配對碼；請使用以下命令核准：
   - `openclaw pairing approve googlechat <code>`
5. 群組空間預設需要 @提及（mention）。如果提及偵測需要應用程式的使用者名稱，請使用 `botUser`。

## 目標

使用這些識別碼進行發送與白名單設定：

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
      botUser: "users/1234567890", // 選填；有助於提及偵測
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
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

注意：

- 服務帳戶憑證也可以透過 `serviceAccount` 以內嵌方式（JSON 字串）傳遞。
- 如果未設定 `webhookPath`，預設 webhook 路徑為 `/googlechat`。
- 當啟用 `actions.reactions` 時，可透過 `reactions` 工具與 `channels action` 使用表情回應。
- `typingIndicator` 支援 `none`、`message`（預設）與 `reaction`（reaction 需要使用者 OAuth）。
- 附件透過 Chat API 下載並儲存在媒體管線（media pipeline）中（大小上限由 `mediaMaxMb` 限制）。

## 疑難排解

### 405 Method Not Allowed

如果 Google Cloud Logs Explorer 顯示如下錯誤：

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

這表示 webhook 處理器未註冊。常見原因：

1. **頻道未設定**：您的設定中缺少 `channels.googlechat` 區塊。請透過以下方式驗證：

   ```bash
   openclaw config get channels.googlechat
   ```

   如果傳回 "Config path not found"，請新增設定（參見[設定重點](#設定重點)）。

2. **外掛程式未啟用**：檢查外掛程式狀態：

   ```bash
   openclaw plugins list | grep googlechat
   ```

   如果顯示 "disabled"，請將 `plugins.entries.googlechat.enabled: true` 新增至您的設定中。

3. **Gateway 未重新啟動**：新增設定後，請重新啟動 Gateway：

   ```bash
   openclaw gateway restart
   ```

驗證頻道是否正在執行：

```bash
openclaw channels status
# 應顯示：Google Chat default: enabled, configured, ...
```

### 其他問題

- 檢查 `openclaw channels status --probe` 以查看驗證錯誤或缺失的 audience 設定。
- 如果沒有收到訊息，請確認 Chat 應用程式的 webhook URL 與事件訂閱。
- 如果提及閘控（mention gating）封鎖了回覆，請將 `botUser` 設定為應用程式的使用者資源名稱，並驗證 `requireMention`。
- 發送測試訊息時使用 `openclaw logs --follow` 以查看請求是否到達 Gateway。

相關文件：

- [Gateway 設定](/gateway/configuration)
- [安全性](/gateway/security)
- [表情回應](/tools/reactions)
