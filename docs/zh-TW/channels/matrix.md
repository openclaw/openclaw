---
summary: "Matrix 支援狀態、功能與設定"
read_when:
  - 開發 Matrix 頻道功能時
title: "Matrix"
---

# Matrix (外掛程式)

Matrix 是一個開放、去中心化的訊息協定。OpenClaw 作為 Matrix **使用者**連線至任何家伺服器，因此您的機器人需要一個 Matrix 帳號。登入後，您可以直接私訊機器人，或邀請它加入聊天室 (Matrix「群組」)。Beeper 也是一個有效的用戶端選項，但它需要啟用 E2EE。

狀態：透過外掛程式支援 ( @vector-im/matrix-bot-sdk)。私訊、聊天室、討論串、媒體、表情回應、投票（傳送 + 文字形式的投票開始）、位置以及 E2EE（含加密支援）。

## 需要外掛程式

Matrix 作為外掛程式提供，不隨核心安裝包捆綁。

透過 CLI 安裝 (npm registry)：

```bash
openclaw plugins install @openclaw/matrix
```

本機程式碼庫 (從 git 程式碼庫執行時)：

```bash
openclaw plugins install ./extensions/matrix
```

如果您在設定/新手導覽期間選擇 Matrix 且偵測到 git 程式碼庫，OpenClaw 將自動提供本機安裝路徑。

了解詳情：[外掛程式](/tools/plugin)

## 設定

1.  安裝 Matrix 外掛程式：
    -   從 npm：`openclaw plugins install @openclaw/matrix`
    -   從本機程式碼庫：`openclaw plugins install ./extensions/matrix`
2.  在家伺服器上建立 Matrix 帳號：
    -   瀏覽主機選項：[https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
    -   或自行架設。
3.  取得機器人帳號的存取權杖：
    -   在家伺服器上使用 `curl` 呼叫 Matrix 登入 API：

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

    -   將 `matrix.example.org` 替換為您的家伺服器 URL。
    -   或設定 `channels.matrix.userId` + `channels.matrix.password`：OpenClaw 會呼叫相同的登入端點，將存取權杖儲存在 `~/.openclaw/credentials/matrix/credentials.json` 中，並在下次啟動時重複使用。

4.  設定憑證：
    -   環境變數：`MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`（或 `MATRIX_USER_ID` + `MATRIX_PASSWORD`）
    -   或設定：`channels.matrix.*`
    -   如果兩者都設定，則設定優先。
    -   使用存取權杖：使用者 ID 會透過 `/whoami` 自動擷取。
    -   設定時，`channels.matrix.userId` 應為完整的 Matrix ID（範例：` @bot:example.org`）。
5.  重新啟動 Gateway（或完成新手導覽）。
6.  從任何 Matrix 用戶端（Element、Beeper 等；請參閱 [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)）開始與機器人私訊或邀請其加入聊天室。Beeper 需要 E2EE，因此請將 `channels.matrix.encryption: true` 並驗證裝置。

最小設定（存取權杖，使用者 ID 自動擷取）：

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

E2EE 設定（啟用端對端加密）：

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

端對端加密透過 Rust 加密 SDK **支援**。

透過 `channels.matrix.encryption: true` 啟用：

-   如果加密模組載入，加密聊天室會自動解密。
-   傳出媒體在傳送到加密聊天室時會被加密。
-   首次連線時，OpenClaw 會向您的其他工作階段請求裝置驗證。
-   在另一個 Matrix 用戶端（Element 等）中驗證裝置以啟用金鑰共享。
-   如果加密模組無法載入，E2EE 將被禁用且加密聊天室將無法解密；OpenClaw 會記錄警告。
-   如果您看到缺少加密模組的錯誤（例如 ` @matrix-org/matrix-sdk-crypto-nodejs-*`），請允許 ` @matrix-org/matrix-sdk-crypto-nodejs` 的建置腳本，並執行 `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` 或使用 `node node_modules/ @matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` 擷取二進位檔案。

加密狀態依帳號 + 存取權杖儲存在 `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`（SQLite 資料庫）中。同步狀態與其一同儲存在 `bot-storage.json` 中。
如果存取權杖（裝置）變更，會建立一個新的儲存區，並且機器人必須重新驗證才能使用加密聊天室。

**裝置驗證：**
當啟用 E2EE 時，機器人會在啟動時從您的其他工作階段請求驗證。
開啟 Element（或其他用戶端）並核准驗證請求以建立信任。
驗證後，機器人可以在加密聊天室中解密訊息。

## 多帳號

多帳號支援：使用 `channels.matrix.accounts`，搭配每個帳號的憑證和選用的 `name`。請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 以了解共用模式。

每個帳號作為獨立的 Matrix 使用者在任何家伺服器上執行。每個帳號的設定繼承自頂層 `channels.matrix` 設定，並且可以覆寫任何選項（私訊策略、群組、加密等）。

```json5
{
  channels: {
    matrix: {
      enabled: true,
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          name: "Main assistant",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_***",
          encryption: true,
        },
        alerts: {
          name: "Alerts bot",
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_***",
          dm: { policy: "allowlist", allowFrom: [" @admin:example.org"] },
        },
      },
    },
  },
}
```

注意：

-   帳號啟動會序列化，以避免與並行模組匯入產生競爭條件。
-   環境變數（`MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN` 等）僅適用於**預設**帳號。
-   基本頻道設定（私訊策略、群組策略、提及門控等）適用於所有帳號，除非每個帳號都覆寫。
-   使用 `bindings[].match.accountId` 將每個帳號路由到不同的智慧代理。
-   加密狀態依帳號 + 存取權杖儲存（每個帳號獨立的金鑰儲存）。

## 路由模型

-   回覆總是傳回 Matrix。
-   私訊共享智慧代理的主要工作階段；聊天室映射到群組工作階段。

## 存取控制（私訊）

-   預設：`channels.matrix.dm.policy = "pairing"`。未知傳送者會取得配對碼。
-   透過以下方式核准：
    -   `openclaw pairing list matrix`
    -   `openclaw pairing approve matrix <CODE>`
-   公開私訊：`channels.matrix.dm.policy="open"` 加上 `channels.matrix.dm.allowFrom=["*"]`。
-   `channels.matrix.dm.allowFrom` 接受完整的 Matrix 使用者 ID（範例：` @user:server`）。當目錄搜尋找到單一精確符合項時，精靈會將顯示名稱解析為使用者 ID。

## 聊天室（群組）

-   預設：`channels.matrix.groupPolicy = "allowlist"`（提及門控）。當未設定時，使用 `channels.defaults.groupPolicy` 覆寫預設值。
-   透過 `channels.matrix.groups` 允許聊天室（聊天室 ID 或別名；當目錄搜尋找到單一精確符合項時，名稱會解析為 ID）：

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

-   `requireMention: false` 在該聊天室中啟用自動回覆。
-   `groups."*"` 可以設定所有聊天室提及門控的預設值。
-   `groupAllowFrom` 限制哪些傳送者可以在聊天室中觸發機器人（完整的 Matrix 使用者 ID）。
-   每個聊天室的 `users` 允許清單可以進一步限制特定聊天室內的傳送者（使用完整的 Matrix 使用者 ID）。
-   設定精靈會提示聊天室允許清單（聊天室 ID、別名或名稱），並且只在精確、唯一的符合項上解析名稱。
-   啟動時，OpenClaw 會將允許清單中的聊天室/使用者名稱解析為 ID 並記錄映射；未解析的項目將被忽略，不進行允許清單比對。
-   邀請預設自動加入；透過 `channels.matrix.autoJoin` 和 `channels.matrix.autoJoinAllowlist` 進行控制。
-   若要**不允許任何聊天室**，請設定 `channels.matrix.groupPolicy: "disabled"`（或保留空的允許清單）。
-   舊版鍵名：`channels.matrix.rooms`（與 `groups` 相同格式）。

## 討論串

-   支援回覆討論串。
-   `channels.matrix.threadReplies` 控制回覆是否保留在討論串中：
    -   `off`、`inbound`（預設）、`always`
-   `channels.matrix.replyToMode` 控制不在討論串中回覆時的回覆中繼資料：
    -   `off`（預設）、`first`、`all`

## 功能

| 功能         | 狀態                                                      |
| :----------- | :-------------------------------------------------------- |
| 私訊         | ✅ 支援                                                   |
| 聊天室       | ✅ 支援                                                   |
| 討論串       | ✅ 支援                                                   |
| 媒體         | ✅ 支援                                                   |
| E2EE         | ✅ 支援（需要加密模組）                                   |
| 表情回應     | ✅ 支援（透過工具傳送/讀取）                              |
| 投票         | ✅ 支援傳送；傳入的投票開始會轉換為文字（回應/結束將被忽略） |
| 位置         | ✅ 支援（geo URI；忽略海拔）                              |
| 原生指令     | ✅ 支援                                                   |

## 疑難排解

請先依序執行以下步驟：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然後，如果需要，確認私訊配對狀態：

```bash
openclaw pairing list matrix
```

常見故障：

-   已登入但聊天室訊息被忽略：聊天室被 `groupPolicy` 或聊天室允許清單阻擋。
-   私訊被忽略：當 `channels.matrix.dm.policy="pairing"` 時，傳送者待核准。
-   加密聊天室失敗：加密支援或加密設定不符。

如需分類流程：[/channels/troubleshooting](/channels/troubleshooting)。

## 設定參考（Matrix）

完整設定：[設定](/gateway/configuration)

供應商選項：

-   `channels.matrix.enabled`：啟用/禁用頻道啟動。
-   `channels.matrix.homeserver`：家伺服器 URL。
-   `channels.matrix.userId`：Matrix 使用者 ID（存取權杖為選用）。
-   `channels.matrix.accessToken`：存取權杖。
-   `channels.matrix.password`：登入密碼（權杖已儲存）。
-   `channels.matrix.deviceName`：裝置顯示名稱。
-   `channels.matrix.encryption`：啟用 E2EE（預設：false）。
-   `channels.matrix.initialSyncLimit`：初始同步限制。
-   `channels.matrix.threadReplies`：`off | inbound | always`（預設：inbound）。
-   `channels.matrix.textChunkLimit`：傳出文字區塊大小（字元）。
-   `channels.matrix.chunkMode`：`length`（預設）或 `newline` 在長度分塊前按空行（段落邊界）分割。
-   `channels.matrix.dm.policy`：`pairing | allowlist | open | disabled`（預設：pairing）。
-   `channels.matrix.dm.allowFrom`：私訊允許清單（完整的 Matrix 使用者 ID）。`open` 需要 `"*"`。精靈會盡可能將名稱解析為 ID。
-   `channels.matrix.groupPolicy`：`allowlist | open | disabled`（預設：allowlist）。
-   `channels.matrix.groupAllowFrom`：群組訊息的允許傳送者（完整的 Matrix 使用者 ID）。
-   `channels.matrix.allowlistOnly`：強制執行私訊 + 聊天室的允許清單規則。
-   `channels.matrix.groups`：群組允許清單 + 每個聊天室的設定映射。
-   `channels.matrix.rooms`：舊版群組允許清單/設定。
-   `channels.matrix.replyToMode`：討論串/標籤的回覆模式。
-   `channels.matrix.mediaMaxMb`：傳入/傳出媒體上限（MB）。
-   `channels.matrix.autoJoin`：邀請處理（`always | allowlist | off`，預設：always）。
-   `channels.matrix.autoJoinAllowlist`：自動加入的允許聊天室 ID/別名。
-   `channels.matrix.accounts`：以帳號 ID 為鍵的多帳號設定（每個帳號繼承頂層設定）。
-   `channels.matrix.actions`：每個動作的工具門控（表情回應/訊息/釘選/成員資訊/頻道資訊）。
