---
summary: "Matrix support status, capabilities, and configuration"
read_when:
  - Working on Matrix channel features
title: Matrix
---

# Matrix (插件)

Matrix 是一個開放的去中心化訊息協議。OpenClaw 以 Matrix **使用者** 的身份連接到任何 homeserver，因此您需要一個 Matrix 帳戶來使用這個機器人。一旦登入後，您可以直接私訊機器人或邀請它進入房間（Matrix 的「群組」）。Beeper 也是一個有效的用戶端選擇，但需要啟用端對端加密 (E2EE)。

狀態：透過插件 (@vector-im/matrix-bot-sdk) 支援。直接訊息、房間、主題、媒體、反應、投票（以文字形式發送 + 開始投票）、位置，以及 E2EE（支援加密）。

## 需要插件

Matrix 作為一個插件發佈，並不與核心安裝包一起捆綁。

透過 CLI 安裝（npm 註冊中心）：

```bash
openclaw plugins install @openclaw/matrix
```

[[BLOCK_1]]  
本地檢出（當從 git 倉庫執行時）：  
[[BLOCK_1]]

```bash
openclaw plugins install ./extensions/matrix
```

如果您在設定/啟動過程中選擇 Matrix，並且檢測到 git checkout，OpenClaw 將自動提供本地安裝路徑。

[[INLINE_1]]

## Setup

1. 安裝 Matrix 插件：
   - 從 npm：`openclaw plugins install @openclaw/matrix`
   - 從本地檢出：`openclaw plugins install ./extensions/matrix`
2. 在主伺服器上創建一個 Matrix 帳戶：
   - 瀏覽主機選項 [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - 或者自己主機。
3. 獲取機器人帳戶的存取token：
   - 使用 Matrix 登入 API，並在您的主伺服器上使用 `curl`：

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

- 將 `matrix.example.org` 替換為您的主伺服器 URL。
  - 或者設定 `channels.matrix.userId` + `channels.matrix.password`：OpenClaw 會調用相同的
    登入端點，將存取token儲存在 `~/.openclaw/credentials/matrix/credentials.json` 中，
    並在下次啟動時重複使用它。

4. 設定憑證：
   - 環境變數：`MATRIX_HOMESERVER`，`MATRIX_ACCESS_TOKEN`（或 `MATRIX_USER_ID` + `MATRIX_PASSWORD`）
   - 或設定：`channels.matrix.*`
   - 如果兩者都設置，則設定優先。
   - 使用存取token時：用戶 ID 會透過 `/whoami` 自動獲取。
   - 設置時，`channels.matrix.userId` 應為完整的 Matrix ID（範例：`@bot:example.org`）。
5. 重新啟動網關（或完成入門）。
6. 與機器人開始私訊或從任何 Matrix 用戶端邀請它進入房間（Element、Beeper 等；請參見 [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)）。Beeper 需要 E2EE，因此請設置 `channels.matrix.encryption: true` 並驗證設備。

最小設定（存取權杖、用戶 ID 自動擷取）：

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

端對端加密是 **支援** 透過 Rust 加密 SDK。

Enable with `channels.matrix.encryption: true`:

- 如果加密模組載入，則加密房間會自動解密。
- 當發送到加密房間時，傳出的媒體會被加密。
- 在首次連接時，OpenClaw 會請求來自其他會話的裝置驗證。
- 在其他 Matrix 用戶端（如 Element 等）中驗證裝置以啟用金鑰共享。
- 如果無法載入加密模組，則 E2EE 會被禁用，且加密房間將無法解密；OpenClaw 會記錄一個警告。
- 如果您看到缺少加密模組的錯誤（例如，`@matrix-org/matrix-sdk-crypto-nodejs-*`），請允許 `@matrix-org/matrix-sdk-crypto-nodejs` 的建置腳本並執行 `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` 或使用 `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` 下載二進位檔。

加密狀態是根據每個帳戶 + 存取權杖儲存於 `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/` (SQLite 資料庫)。同步狀態與之共存於 `bot-storage.json`。如果存取權杖（裝置）變更，則會創建一個新的儲存，並且機器人必須重新驗證以進入加密房間。

**裝置驗證：**  
當 E2EE 被啟用時，機器人在啟動時會請求您其他會話的驗證。  
打開 Element（或其他用戶端）並批准驗證請求以建立信任。  
一旦驗證完成，機器人就可以在加密房間中解密消息。

## Multi-account

多帳戶支援：使用 `channels.matrix.accounts` 搭配每個帳戶的憑證和可選的 `name`。請參閱 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 以了解共享模式。

每個帳戶作為任何 homeserver 上的獨立 Matrix 使用者執行。每個帳戶的設定繼承自頂層 `channels.matrix` 設定，並且可以覆蓋任何選項（DM 政策、群組、加密等）。

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
          dm: { policy: "allowlist", allowFrom: ["@admin:example.org"] },
        },
      },
    },
  },
}
```

[[BLOCK_1]]

- 帳戶啟動是序列化的，以避免與並行模組導入的競爭條件。
- 環境變數 (`MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, 等等) 僅適用於 **預設** 帳戶。
- 基本頻道設定（DM 政策、群組政策、提及限制等等）適用於所有帳戶，除非每個帳戶另有覆蓋。
- 使用 `bindings[].match.accountId` 將每個帳戶路由到不同的代理。
- 加密狀態是按帳戶 + 存取token儲存的（每個帳戶有獨立的金鑰儲存）。

## Routing model

- 回覆總是回到 Matrix。
- 直接訊息 (DMs) 共享代理的主要會話；房間對應到群組會話。

## 存取控制 (DMs)

- 預設: `channels.matrix.dm.policy = "pairing"`。未知的發送者會獲得配對碼。
- 通過以下方式批准：
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- 公開 DM: `channels.matrix.dm.policy="open"` 加上 `channels.matrix.dm.allowFrom=["*"]`。
- `channels.matrix.dm.allowFrom` 接受完整的 Matrix 使用者 ID（範例: `@user:server`）。當目錄搜尋找到單一精確匹配時，向導會將顯示名稱解析為使用者 ID。
- 請勿使用顯示名稱或裸本地部分（範例: `"Alice"` 或 `"alice"`）。它們是模糊的，並且在允許清單匹配中會被忽略。請使用完整的 `@user:server` ID。

## Rooms (groups)

- 預設: `channels.matrix.groupPolicy = "allowlist"` (提及限制)。當未設置時，使用 `channels.defaults.groupPolicy` 來覆蓋預設值。
- 執行時注意事項: 如果 `channels.matrix` 完全缺失，執行時將回退到 `groupPolicy="allowlist"` 進行房間檢查（即使 `channels.defaults.groupPolicy` 已設置）。
- 允許清單房間使用 `channels.matrix.groups` （房間 ID 或別名；當目錄搜尋找到單一精確匹配時，名稱將解析為 ID）：

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

- `requireMention: false` 使該房間啟用自動回覆功能。
- `groups."*"` 可以設定跨房間的提及閘道預設值。
- `groupAllowFrom` 限制哪些發送者可以在房間中觸發機器人（完整的 Matrix 使用者 ID）。
- 每個房間的 `users` 允許清單可以進一步限制特定房間內的發送者（使用完整的 Matrix 使用者 ID）。
- 設定精靈會提示輸入房間允許清單（房間 ID、別名或名稱），並僅在完全且唯一匹配時解析名稱。
- 在啟動時，OpenClaw 會將允許清單中的房間/使用者名稱解析為 ID 並記錄對應關係；未解析的條目將在允許清單匹配中被忽略。
- 邀請預設會自動加入；可透過 `channels.matrix.autoJoin` 和 `channels.matrix.autoJoinAllowlist` 進行控制。
- 若要不允許任何房間，請設定 `channels.matrix.groupPolicy: "disabled"`（或保持允許清單為空）。
- 舊版金鑰：`channels.matrix.rooms`（形狀與 `groups` 相同）。

## Threads

- 支援回覆串接。
- `channels.matrix.threadReplies` 控制回覆是否保持在串接中：
  - `off`、`inbound`（預設）、`always`
- `channels.matrix.replyToMode` 控制在不使用串接回覆時的回覆元資料：
  - `off`（預設）、`first`、`all`

## Capabilities

| 功能       | 狀態                                                         |
| ---------- | ------------------------------------------------------------ |
| 直接訊息   | ✅ 支援                                                      |
| 房間       | ✅ 支援                                                      |
| 主題       | ✅ 支援                                                      |
| 媒體       | ✅ 支援                                                      |
| 端對端加密 | ✅ 支援（需要加密模組）                                      |
| 反應       | ✅ 支援（透過工具發送/閱讀）                                 |
| 投票       | ✅ 支援發送；進來的投票開始會轉換為文字（回應/結束會被忽略） |
| 位置       | ✅ 支援（地理 URI；高度被忽略）                              |
| 原生指令   | ✅ 支援                                                      |

## 故障排除

執行這個梯子：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然後確認 DM 配對狀態（如果需要）：

```bash
openclaw pairing list matrix
```

常見故障：

- 已登入但房間訊息被忽略：房間被 `groupPolicy` 阻擋或房間允許清單。
- 直接訊息被忽略：發送者待批准時 `channels.matrix.dm.policy="pairing"`。
- 加密房間失敗：加密支援或加密設定不匹配。

[[BLOCK_1]]  
對於分流流程：[/channels/troubleshooting](/channels/troubleshooting)。  
[[BLOCK_1]]

## 設定參考 (Matrix)

完整設定: [Configuration](/gateway/configuration)

Provider options:

- `channels.matrix.enabled`: 啟用/禁用頻道啟動。
- `channels.matrix.homeserver`: 主伺服器 URL。
- `channels.matrix.userId`: Matrix 使用者 ID（可選，搭配存取權杖）。
- `channels.matrix.accessToken`: 存取權杖。
- `channels.matrix.password`: 登入密碼（權杖已儲存）。
- `channels.matrix.deviceName`: 裝置顯示名稱。
- `channels.matrix.encryption`: 啟用端對端加密 (E2EE)（預設：false）。
- `channels.matrix.initialSyncLimit`: 初始同步限制。
- `channels.matrix.threadReplies`: `off | inbound | always`（預設：進入）。
- `channels.matrix.textChunkLimit`: 外發文字塊大小（字元）。
- `channels.matrix.chunkMode`: `length`（預設）或 `newline` 在長度分塊之前根據空白行（段落邊界）進行分割。
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled`（預設：配對）。
- `channels.matrix.dm.allowFrom`: DM 允許清單（完整的 Matrix 使用者 ID）。`open` 需要 `"*"`。精靈會在可能的情況下將名稱解析為 ID。
- `channels.matrix.groupPolicy`: `allowlist | open | disabled`（預設：允許清單）。
- `channels.matrix.groupAllowFrom`: 群組訊息的允許發送者（完整的 Matrix 使用者 ID）。
- `channels.matrix.allowlistOnly`: 強制 DM + 房間的允許清單規則。
- `channels.matrix.groups`: 群組允許清單 + 每房間設定映射。
- `channels.matrix.rooms`: 遺留的群組允許清單/設定。
- `channels.matrix.replyToMode`: 針對主題/標籤的回覆模式。
- `channels.matrix.mediaMaxMb`: 進入/外發媒體上限（MB）。
- `channels.matrix.autoJoin`: 邀請處理（`always | allowlist | off`，預設：始終）。
- `channels.matrix.autoJoinAllowlist`: 自動加入的允許房間 ID/別名。
- `channels.matrix.accounts`: 以帳戶 ID 為鍵的多帳戶設定（每個帳戶繼承頂層設定）。
- `channels.matrix.actions`: 每個動作的工具限制（反應/訊息/釘選/成員資訊/頻道資訊）。
