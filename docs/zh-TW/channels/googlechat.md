---
summary: "Google Chat 應用程式支援狀態、功能與設定"
read_when:
  - 進行 Google Chat 頻道功能開發時
title: "Google Chat"
---

# Google Chat（Chat API）

狀態：已就緒，支援透過 Google Chat API webhook 的私訊（DMs）與空間（spaces）（僅 HTTP）。

## 快速設定（初學者）

1. 建立一個 Google Cloud 專案並啟用 **Google Chat API**。
   - 前往：[Google Chat API 憑證](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - 若尚未啟用，請啟用該 API。
2. 建立 **Service Account**：
   - 點擊 **Create Credentials** > **Service Account**。
   - 任意命名（例如：`openclaw-chat`）。
   - 權限留空（按 **Continue**）。
   - 22. 將可存取的主體留空（按 **Done**）。
3. 建立並下載 **JSON Key**：
   - 23. 在服務帳戶清單中，點擊你剛建立的那個。
   - 前往 **Keys** 分頁。
   - 點擊 **Add Key** > **Create new key**。
   - 選擇 **JSON** 並按 **Create**。
4. 將下載的 JSON 檔案儲存在你的閘道器主機上（例如：`~/.openclaw/googlechat-service-account.json`）。
5. 在 [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 建立 Google Chat 應用程式：
   - 填寫 **Application info**：
     - **App name**：（例如：`OpenClaw`）
     - **Avatar URL**：（例如：`https://openclaw.ai/logo.png`）
     - **Description**：（例如：`Personal AI Assistant`）
   - 啟用 **Interactive features**。
   - 在 **Functionality** 下，勾選 **Join spaces and group conversations**。
   - 在 **Connection settings** 下，選擇 **HTTP endpoint URL**。
   - 在 **Triggers** 下，選擇 **Use a common HTTP endpoint URL for all triggers**，並設定為你的閘道器公開 URL，後接 `/googlechat`。
     - _提示：執行 `openclaw status` 以取得你的閘道器公開 URL。_
   - 在 **Visibility** 下，勾選 **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**。
   - 在文字方塊中輸入你的電子郵件地址（例如：`user@example.com`）。
   - 點擊底部的 **Save**。
6. **啟用應用程式狀態**：
   - 儲存後，**重新整理頁面**。
   - 尋找 **App status** 區段（通常在儲存後的頁面頂部或底部）。
   - 將狀態變更為 **Live - available to users**。
   - 再次點擊 **Save**。
7. 使用 Service Account 路徑與 webhook audience 設定 OpenClaw：
   - 環境變數：`GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 或設定檔：`channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`。
8. 設定 webhook audience 的類型與值（需與你的 Chat 應用程式設定相符）。
9. 啟動 Gateway 閘道器. 啟動 Gateway 閘道器。Google Chat 將會對你的 webhook 路徑發送 POST 請求。

## 新增至 Google Chat

當 Gateway 閘道器正在執行，且你的電子郵件已加入可見性清單後：

1. 前往 [Google Chat](https://chat.google.com/)。
2. 點擊 **Direct Messages** 旁的 **+**（加號）圖示。
3. 在搜尋列（平常新增聯絡人的地方）中，輸入你在 Google Cloud Console 設定的 **App name**。
   - **注意**：由於這是私人應用程式，機器人 _不會_ 出現在「Marketplace」瀏覽清單中，必須以名稱搜尋。 24. 你必須依名稱搜尋它。
4. 25. 從結果中選擇你的機器人。
5. 點擊 **Add** 或 **Chat** 以開始 1:1 對話。
6. 傳送「Hello」以觸發助理！

## 公開 URL（僅 webhook）

Google Chat webhook 需要一個公開的 HTTPS 端點。基於安全性考量，**僅將 `/googlechat` 路徑暴露到網際網路**。請將 OpenClaw 儀表板與其他敏感端點保留在你的私有網路中。 26. 為了安全，**只將 `/googlechat` 路徑對外公開**。 27. 將 OpenClaw 儀表板與其他敏感端點保留在你的私人網路中。

### 選項 A：Tailscale Funnel（建議）

28. 私人儀表板使用 Tailscale Serve，公開的 webhook 路徑使用 Funnel。 29. 這會保持 `/` 為私人，同時只公開 `/googlechat`。

1. **檢查你的閘道器綁定的位址：**

   ```bash
   ss -tlnp | grep 18789
   ```

   記下 IP 位址（例如：`127.0.0.1`、`0.0.0.0`，或你的 Tailscale IP，如 `100.x.x.x`）。

2. **僅向 tailnet 暴露儀表板（連接埠 8443）：**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **僅公開 webhook 路徑：**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. 30. **授權節點使用 Funnel 存取：**
       若出現提示，請造訪輸出中顯示的授權 URL，以在你的 tailnet 政策中為此節點啟用 Funnel。

5. **驗證設定：**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

你的公開 webhook URL 將是：
`https://<node-name>.<tailnet>.ts.net/googlechat`

你的私有儀表板仍僅限於 tailnet：
`https://<node-name>.<tailnet>.ts.net:8443/`

在 Google Chat 應用程式設定中，請使用公開 URL（不包含 `:8443`）。

> 31. 注意：此設定在重新開機後仍會保留。 32. 若之後要移除，請執行 `tailscale funnel reset` 與 `tailscale serve reset`。

### 選項 B：反向代理（Caddy）

若你使用如 Caddy 的反向代理，請僅代理特定路徑：

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

在此設定下，任何對 `your-domain.com/` 的請求都會被忽略或回傳 404，而 `your-domain.com/googlechat` 則會安全地路由至 OpenClaw。

### 選項 C：Cloudflare Tunnel

設定你的 Tunnel ingress 規則，僅路由 webhook 路徑：

- **Path**：`/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**：HTTP 404（Not Found）

## How it works

1. Google Chat 會向 Gateway 閘道器發送 webhook POST。每個請求都包含 `Authorization: Bearer <token>` 標頭。 33. 每個請求都包含 `Authorization: Bearer <token>` 標頭。
2. OpenClaw 會依據設定的 `audienceType` 與 `audience` 驗證權杖：
   - `audienceType: "app-url"` → audience 為你的 HTTPS webhook URL。
   - `audienceType: "project-number"` → audience 為 Cloud 專案編號。
3. 訊息會依空間進行路由：
   - 私訊使用工作階段金鑰 `agent:<agentId>:googlechat:dm:<spaceId>`。
   - 空間使用工作階段金鑰 `agent:<agentId>:googlechat:group:<spaceId>`。
4. 34. 私訊存取預設為配對制。 私訊預設需要配對。未知寄件者會收到配對碼；可使用以下指令核准：
   - `openclaw pairing approve googlechat <code>`
5. 35. 群組空間預設需要 @ 提及。 36. 若提及偵測需要應用程式的使用者名稱，請使用 `botUser`。

## 目標

使用以下識別碼進行投遞與允許清單設定：

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

注意事項：

- Service Account 憑證也可透過 `serviceAccount` 以內嵌方式傳遞（JSON 字串）。
- 若未設定 `webhookPath`，預設 webhook 路徑為 `/googlechat`。
- 當啟用 `actions.reactions` 時，可透過 `reactions` 工具與 `channels action` 使用回應（reactions）。
- `typingIndicator` 支援 `none`、`message`（預設）以及 `reaction`（回應需要使用者 OAuth）。
- 附件會透過 Chat API 下載，並儲存在媒體管線中（大小上限由 `mediaMaxMb` 限制）。

## 37. 疑難排解

### 405 Method Not Allowed

若 Google Cloud Logs Explorer 顯示如下錯誤：

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

38. 這表示 webhook 處理器尚未註冊。 39. 常見原因：

1. **頻道未設定**：設定檔中缺少 `channels.googlechat` 區段。請使用以下指令驗證： 40. 使用以下方式驗證：

   ```bash
   openclaw config get channels.googlechat
   ```

   若回傳「Config path not found」，請新增設定（參見 [設定重點](#config-highlights)）。

2. 1. **外掛未啟用**：檢查外掛狀態：

   ```bash
   openclaw plugins list | grep googlechat
   ```

   若顯示「disabled」，請在設定中加入 `plugins.entries.googlechat.enabled: true`。

3. **Gateway 閘道器未重新啟動**：新增設定後，請重新啟動 Gateway 閘道器：

   ```bash
   openclaw gateway restart
   ```

確認頻道正在執行：

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### 其他問題

- 檢查 `openclaw channels status --probe` 是否有身分驗證錯誤或 audience 設定遺漏。
- 若未收到任何訊息，請確認 Chat 應用程式的 webhook URL 與事件訂閱設定。
- 若提及門檻阻擋回覆，請將 `botUser` 設為應用程式的使用者資源名稱，並驗證 `requireMention`。
- 傳送測試訊息時使用 `openclaw logs --follow`，以確認請求是否到達 Gateway 閘道器。

2. 相關文件：

- [Gateway 設定](/gateway/configuration)
- [安全性](/gateway/security)
- [回應（Reactions）](/tools/reactions)
