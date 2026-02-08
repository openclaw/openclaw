---
summary: 「Matrix 支援狀態、功能與設定」
read_when:
  - 進行 Matrix 頻道功能相關工作時
title: 「Matrix」
x-i18n:
  source_path: channels/matrix.md
  source_hash: 199b954b901cbb17
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:15Z
---

# Matrix（外掛）

Matrix 是一種開放、去中心化的即時通訊協定。OpenClaw 會以 Matrix **使用者**
身分連線到任何 homeserver，因此你需要一個 Matrix 帳號給機器人使用。登入完成後，你可以直接私訊
機器人，或邀請它加入房間（Matrix「群組」）。Beeper 也是可行的用戶端選項，但需要啟用 E2EE。

狀態：透過外掛支援（@vector-im/matrix-bot-sdk）。支援私訊、房間、執行緒、媒體、表情回應、
投票（傳送 + 將 poll-start 作為文字）、位置，以及 E2EE（含加密支援）。

## 需要外掛

Matrix 以外掛形式提供，未隨核心安裝一併提供。

透過 CLI 安裝（npm registry）：

```bash
openclaw plugins install @openclaw/matrix
```

本機檢出（從 git repo 執行時）：

```bash
openclaw plugins install ./extensions/matrix
```

若在設定／入門引導期間選擇 Matrix，且偵測到 git 檢出，
OpenClaw 會自動提供本機安裝路徑。

詳細資訊：[Plugins](/tools/plugin)

## 設定

1. 安裝 Matrix 外掛：
   - 從 npm：`openclaw plugins install @openclaw/matrix`
   - 從本機檢出：`openclaw plugins install ./extensions/matrix`
2. 在 homeserver 上建立 Matrix 帳號：
   - 瀏覽託管選項：[https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - 或自行架設。
3. 為機器人帳號取得存取權杖：
   - 在你的 homeserver 上使用 Matrix 登入 API，搭配 `curl`：

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

   - 將 `matrix.example.org` 替換為你的 homeserver URL。
   - 或設定 `channels.matrix.userId` + `channels.matrix.password`：OpenClaw 會呼叫相同的
     登入端點，將存取權杖儲存在 `~/.openclaw/credentials/matrix/credentials.json`，
     並在下次啟動時重用。

4. 設定認證資訊：
   - 環境變數：`MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`（或 `MATRIX_USER_ID` + `MATRIX_PASSWORD`）
   - 或設定檔：`channels.matrix.*`
   - 若同時設定，設定檔優先。
   - 使用存取權杖時，使用者 ID 會透過 `/whoami` 自動取得。
   - 設定時，`channels.matrix.userId` 應為完整的 Matrix ID（範例：`@bot:example.org`）。
5. 重新啟動 Gateway 閘道器（或完成入門引導）。
6. 從任何 Matrix 用戶端與機器人開始私訊，或邀請它加入房間
   （Element、Beeper 等；請參考 [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)）。Beeper 需要 E2EE，
   因此請設定 `channels.matrix.encryption: true` 並驗證裝置。

最小設定（存取權杖，使用者 ID 自動取得）：

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

## 加密（E2EE）

端對端加密透過 Rust crypto SDK **已支援**。

使用 `channels.matrix.encryption: true` 啟用：

- 若成功載入加密模組，會自動解密加密房間。
- 對加密房間送出的媒體會進行加密。
- 初次連線時，OpenClaw 會向你其他工作階段請求裝置驗證。
- 在其他 Matrix 用戶端（Element 等）中驗證裝置以啟用金鑰共享。
- 若無法載入加密模組，將停用 E2EE，且無法解密加密房間；
  OpenClaw 會記錄警告。
- 若看到遺失加密模組的錯誤（例如 `@matrix-org/matrix-sdk-crypto-nodejs-*`），
  請允許 `@matrix-org/matrix-sdk-crypto-nodejs` 的建置指令碼，並執行
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs`，或使用
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` 取得二進位檔。

加密狀態會依帳號 + 存取權杖儲存在
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
（SQLite 資料庫）。同步狀態則位於 `bot-storage.json`。
若存取權杖（裝置）變更，會建立新的儲存區，且機器人必須
重新驗證才能處理加密房間。

**裝置驗證：**
啟用 E2EE 時，機器人會在啟動時向你其他工作階段請求驗證。
請開啟 Element（或其他用戶端）並核准驗證請求以建立信任。
完成驗證後，機器人即可解密加密房間中的訊息。

## 路由模型

- 回覆一律返回 Matrix。
- 私訊共用代理程式的主要工作階段；房間對應到群組工作階段。

## 存取控制（私訊）

- 預設：`channels.matrix.dm.policy = "pairing"`。未知的寄件者會取得配對碼。
- 透過以下方式核准：
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- 公開私訊：`channels.matrix.dm.policy="open"` 加上 `channels.matrix.dm.allowFrom=["*"]`。
- `channels.matrix.dm.allowFrom` 接受完整的 Matrix 使用者 ID（範例：`@user:server`）。當目錄搜尋找到單一且完全符合的結果時，精靈會將顯示名稱解析為使用者 ID。

## 房間（群組）

- 預設：`channels.matrix.groupPolicy = "allowlist"`（提及觸發）。若未設定，使用 `channels.defaults.groupPolicy` 覆寫預設。
- 使用 `channels.matrix.groups` 將房間加入允許清單（房間 ID 或別名；當目錄搜尋找到單一且完全符合的結果時，名稱會解析為 ID）：

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` 啟用該房間的自動回覆。
- `groups."*"` 可設定跨房間的提及觸發預設值。
- `groupAllowFrom` 限制哪些寄件者可在房間中觸發機器人（完整 Matrix 使用者 ID）。
- 每個房間的 `users` 允許清單可進一步限制特定房間內的寄件者（使用完整 Matrix 使用者 ID）。
- 設定精靈會提示輸入房間允許清單（房間 ID、別名或名稱），且僅在完全且唯一符合時解析名稱。
- 啟動時，OpenClaw 會將允許清單中的房間／使用者名稱解析為 ID 並記錄對應；無法解析的項目會被忽略，不用於允許清單比對。
- 預設會自動加入邀請；可使用 `channels.matrix.autoJoin` 與 `channels.matrix.autoJoinAllowlist` 控制。
- 若要**不允許任何房間**，請設定 `channels.matrix.groupPolicy: "disabled"`（或保持允許清單為空）。
- 舊版鍵值：`channels.matrix.rooms`（結構與 `groups` 相同）。

## 執行緒

- 支援回覆執行緒。
- `channels.matrix.threadReplies` 控制回覆是否維持在執行緒中：
  - `off`、`inbound`（預設）、`always`
- `channels.matrix.replyToMode` 控制在非執行緒回覆時的 reply-to 中繼資料：
  - `off`（預設）、`first`、`all`

## 功能

| 功能     | 狀態                                                        |
| -------- | ----------------------------------------------------------- |
| 私訊     | ✅ 支援                                                     |
| 房間     | ✅ 支援                                                     |
| 執行緒   | ✅ 支援                                                     |
| 媒體     | ✅ 支援                                                     |
| E2EE     | ✅ 支援（需要加密模組）                                     |
| 表情回應 | ✅ 支援（透過工具傳送／讀取）                               |
| 投票     | ✅ 支援傳送；接收的投票開始事件會轉為文字（忽略回應／結束） |
| 位置     | ✅ 支援（geo URI；忽略高度）                                |
| 原生命令 | ✅ 支援                                                     |

## 疑難排解

請先執行此階梯：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然後在需要時確認私訊配對狀態：

```bash
openclaw pairing list matrix
```

常見失敗情況：

- 已登入但房間訊息被忽略：房間被 `groupPolicy` 或房間允許清單阻擋。
- 私訊被忽略：在 `channels.matrix.dm.policy="pairing"` 時寄件者尚待核准。
- 加密房間失敗：加密支援或加密設定不相符。

問題分流流程：[/channels/troubleshooting](/channels/troubleshooting)。

## 設定參考（Matrix）

完整設定：[Configuration](/gateway/configuration)

提供者選項：

- `channels.matrix.enabled`：啟用／停用頻道啟動。
- `channels.matrix.homeserver`：homeserver URL。
- `channels.matrix.userId`：Matrix 使用者 ID（使用存取權杖時可選）。
- `channels.matrix.accessToken`：存取權杖。
- `channels.matrix.password`：登入用密碼（會儲存權杖）。
- `channels.matrix.deviceName`：裝置顯示名稱。
- `channels.matrix.encryption`：啟用 E2EE（預設：false）。
- `channels.matrix.initialSyncLimit`：初始同步限制。
- `channels.matrix.threadReplies`：`off | inbound | always`（預設：inbound）。
- `channels.matrix.textChunkLimit`：外送文字分塊大小（字元）。
- `channels.matrix.chunkMode`：`length`（預設）或 `newline`，在長度分塊前先依空白行（段落邊界）分割。
- `channels.matrix.dm.policy`：`pairing | allowlist | open | disabled`（預設：pairing）。
- `channels.matrix.dm.allowFrom`：私訊允許清單（完整 Matrix 使用者 ID）。`open` 需要 `"*"`。精靈會在可行時將名稱解析為 ID。
- `channels.matrix.groupPolicy`：`allowlist | open | disabled`（預設：allowlist）。
- `channels.matrix.groupAllowFrom`：群組訊息的允許寄件者（完整 Matrix 使用者 ID）。
- `channels.matrix.allowlistOnly`：對私訊 + 房間強制套用允許清單規則。
- `channels.matrix.groups`：群組允許清單 + 各房間設定對應表。
- `channels.matrix.rooms`：舊版群組允許清單／設定。
- `channels.matrix.replyToMode`：執行緒／標記的 reply-to 模式。
- `channels.matrix.mediaMaxMb`：入站／出站媒體上限（MB）。
- `channels.matrix.autoJoin`：邀請處理（`always | allowlist | off`，預設：always）。
- `channels.matrix.autoJoinAllowlist`：允許自動加入的房間 ID／別名。
- `channels.matrix.actions`：依動作的工具門檻（reactions/messages/pins/memberInfo/channelInfo）。
