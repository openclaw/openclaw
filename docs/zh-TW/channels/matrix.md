---
summary: "Matrix 支援狀態、功能與設定"
read_when:
  - 開發 Matrix 頻道功能時
title: "Matrix"
---

# Matrix (外掛程式)

Matrix 是一個開放、去中心化的即時通訊協定。OpenClaw 會以 Matrix **使用者**的身分連接至任何主伺服器 (homeserver)，因此你需要一個 Matrix 帳號給機器人使用。登入後，你可以直接傳送私訊 (DM) 給機器人，或將其邀請至房間（Matrix 的「群組」）。Beeper 也是一個可用的用戶端選項，但需要啟用端到端加密 (E2EE)。

狀態：透過外掛程式 ( @vector-im/matrix-bot-sdk) 支援。包含私訊、房間、討論串 (threads)、媒體、表情符號回應 (reactions)、投票（以文字形式發送 + 開始投票）、地點以及端到端加密 (E2EE)（具備加密支援）。

## 需要外掛程式

Matrix 以外掛程式形式提供，並未包含在核心安裝中。

透過 CLI 安裝 (npm 註冊表)：

```bash
openclaw plugins install @openclaw/matrix
```

本地檢出（從 git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/matrix
```

如果你在設定/新手導覽期間選擇 Matrix，且偵測到 git 檢出，OpenClaw 將自動提供本地安裝路徑。

詳情請參閱：[Plugins](/tools/plugin)

## 設定

1. 安裝 Matrix 外掛程式：
   - 從 npm：`openclaw plugins install @openclaw/matrix`
   - 從本地檢出：`openclaw plugins install ./extensions/matrix`
2. 在主伺服器上建立 Matrix 帳號：
   - 瀏覽代管選項：[https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - 或自行架設。
3. 取得機器人帳號的存取權杖 (access token)：
   - 使用 Matrix 登入 API 與 `curl` 連接至你的主伺服器：

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - 將 `matrix.example.org` 替換為你的主伺服器網址。
   - 或者設定 `channels.matrix.userId` + `channels.matrix.password`：OpenClaw 會呼叫相同的登入端點，將存取權杖儲存在 `~/.openclaw/credentials/matrix/credentials.json`，並在下次啟動時重複使用。

4. 設定憑證：
   - 環境變數：`MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (或 `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - 或設定檔：`channels.matrix.*`
   - 如果兩者皆已設定，設定檔優先。
   - 使用存取權杖時：使用者 ID 會透過 `/whoami` 自動擷取。
   - 設定時，`channels.matrix.userId` 應為完整的 Matrix ID (例如：`@bot:example.org`)。
5. 重啟 Gateway（或完成新手導覽）。
6. 從任何 Matrix 用戶端（Element、Beeper 等，請參閱 [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)）開始私訊機器人或將其邀請至房間。Beeper 需要端到端加密 (E2EE)，因此請設定 `channels.matrix.encryption: true` 並驗證裝置。

最小化設定（存取權杖，自動擷取使用者 ID）：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE 設定（啟用端到端加密）：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## 加密 (E2EE)

端到端加密已透過 Rust 加密 SDK 提供**支援**。

使用 `channels.matrix.encryption: true` 啟用：

- 如果加密模組載入成功，加密房間將自動解密。
- 向加密房間發送媒體時，外傳媒體將會被加密。
- 初次連線時，OpenClaw 會從你的其他工作階段要求裝置驗證。
- 在另一個 Matrix 用戶端（如 Element）驗證裝置以啟用金鑰共享。
- 如果無法載入加密模組，端到端加密將被停用，且加密房間將無法解密；OpenClaw 會記錄警告訊息。
- 如果如果你看到缺少加密模組的錯誤（例如 `@matrix-org/matrix-sdk-crypto-nodejs-*`），請允許 `@matrix-org/matrix-sdk-crypto-nodejs` 的建置指令碼並執行 `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` 或使用 `node node_modules/ @matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` 擷取二進位檔案。

加密狀態按帳號 + 存取權杖儲存在 `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/` (SQLite 資料庫)。同步狀態與其併列儲存在 `bot-storage.json`。如果存取權杖（裝置）變更，系統會建立新的儲存區，且機器人必須針對加密房間重新驗證。

**裝置驗證：**
啟用端到端加密 (E2EE) 時，機器人在啟動時會要求從你的其他工作階段進行驗證。請開啟 Element（或其他用戶端）並核准驗證要求以建立信任。驗證完成後，機器人即可解密加密房間中的訊息。

## 多帳號

多帳號支援：使用 `channels.matrix.accounts` 搭配各帳號的憑證及選填的 `name`。請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 了解共用模式。

每個帳號都作為獨立的 Matrix 使用者在主伺服器上執行。個別帳號的設定繼承自頂層的 `channels.matrix` 設定，並可覆寫任何選項（私訊原則、房間、加密等）。

```json5
{
  channels: {
    matrix: {
      enabled: true,
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          name: "主要助理",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_***",
          encryption: true,
        },
        alerts: {
          name: "警告機器人",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_***",
          dm: { policy: "allowlist", allowFrom: [" @admin:example.org"] },
        },
      },
    },
  },
}
```

注意事項：

- 帳號啟動會序列化執行，以避免並行模組導入時產生競態條件。
- 環境變數 (`MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` 等) 僅套用於**預設**帳號。
- 基礎頻道設定（私訊原則、群組原則、提及門檻等）套用於所有帳號，除非針對個別帳號進行覆寫。
- 使用 `bindings[].match.accountId` 將各個帳號路由至不同的智慧代理。
- 加密狀態按帳號 + 存取權杖儲存（每個帳號有獨立的金鑰儲存區）。

## 路由模型

- 回覆一律傳回 Matrix。
- 私訊共享智慧代理的主要工作階段；房間對應至群組工作階段。

## 存取控制 (私訊)

- 預設：`channels.matrix.dm.policy = "pairing"`。不明傳送者會收到配對碼。
- 核准方式：
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- 公開私訊：`channels.matrix.dm.policy="open"` 且 `channels.matrix.dm.allowFrom=["*"]`。
- `channels.matrix.dm.allowFrom` 接受完整的 Matrix 使用者 ID（例如：`@user:server`）。當目錄搜尋找到單一完全符合的結果時，精靈會將顯示名稱解析為使用者 ID。

## 房間 (群組)

- 預設：`channels.matrix.groupPolicy = "allowlist"`（受提及限制）。當未設定時，請使用 `channels.defaults.groupPolicy` 覆寫預設值。
- 使用 `channels.matrix.groups` 設定房間允許清單（房間 ID 或別名；當目錄搜尋找到單一完全符合的結果時，名稱會解析為 ID）：

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: [" @owner:example.org"],
    },
  },
}
```

- `requireMention: false` 可在該房間啟用自動回覆。
- `groups."*"` 可設定跨房間的提及限制預設值。
- `groupAllowFrom` 限制哪些傳送者可以在房間中觸發機器人（完整 Matrix 使用者 ID）。
- 個別房間的 `users` 允許清單可進一步限制特定房間內的傳送者（使用完整 Matrix 使用者 ID）。
- 設定精靈會提示輸入房間允許清單（房間 ID、別名或名稱），且僅在完全、唯一符合時解析名稱。
- 啟動時，OpenClaw 會將允許清單中的房間/使用者名稱解析為 ID 並記錄對應關係；無法解析的項目將在允許清單比對中被忽略。
- 預設會自動加入邀請；透過 `channels.matrix.autoJoin` 和 `channels.matrix.autoJoinAllowlist` 控制。
- 若要**不允許任何房間**，請設定 `channels.matrix.groupPolicy: "disabled"`（或保持空白允許清單）。
- 舊版鍵名：`channels.matrix.rooms`（結構與 `groups` 相同）。

## 討論串 (Threads)

- 支援回覆討論串。
- `channels.matrix.threadReplies` 控制回覆是否保留在討論串中：
  - `off`、`inbound`（預設）、`always`
- `channels.matrix.replyToMode` 控制不回覆討論串時的回覆中介資料：
  - `off`（預設）、`first`、`all
