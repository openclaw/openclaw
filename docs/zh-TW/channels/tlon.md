---
summary: "Tlon/Urbit support status, capabilities, and configuration"
read_when:
  - Working on Tlon/Urbit channel features
title: Tlon
---

# Tlon (插件)

Tlon 是一個建立在 Urbit 上的去中心化訊息應用程式。OpenClaw 連接到你的 Urbit 船隻，並可以回應私訊和群組聊天訊息。群組回覆預設需要 @ 提及，並且可以透過允許清單進一步限制。

狀態：透過插件支援。支援私訊、群組提及、主題回覆、豐富文字格式以及圖片上傳。目前尚不支援反應和投票。

## 需要插件

Tlon 作為一個插件發佈，並不與核心安裝包一起捆綁。

透過 CLI 安裝（npm 註冊中心）：

```bash
openclaw plugins install @openclaw/tlon
```

[[BLOCK_1]]  
本地檢出（當從 git 倉庫執行時）：  
[[BLOCK_1]]

```bash
openclaw plugins install ./extensions/tlon
```

[[INLINE_1]]

## Setup

1. 安裝 Tlon 插件。
2. 收集你的船隻 URL 和登入程式碼。
3. 設定 `channels.tlon`。
4. 重新啟動網關。
5. 私訊機器人或在群組頻道中提及它。

[[BLOCK_1]]  
最小設定（單一帳戶）：  
[[BLOCK_1]]

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
      ownerShip: "~your-main-ship", // recommended: your ship, always allowed
    },
  },
}
```

## Private/LAN 船隻

預設情況下，OpenClaw 會阻擋私有/內部主機名稱和 IP 範圍以保護 SSRF。如果您的船隻執行在私有網路（localhost、LAN IP 或內部主機名稱），您必須明確選擇加入：

```json5
{
  channels: {
    tlon: {
      url: "http://localhost:8080",
      allowPrivateNetwork: true,
    },
  },
}
```

這適用於以下類似的 URL：

- `http://localhost:8080`
- `http://192.168.x.x:8080`
- `http://my-ship.local:8080`

⚠️ 只有在您信任本地網路的情況下才啟用此選項。此設定會禁用對您的船隻 URL 的 SSRF 保護。

## Group channels

自動發現預設為啟用。您也可以手動固定頻道：

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

禁用自動發現：

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## 存取控制

DM 允許清單（空 = 不允許私訊，使用 `ownerShip` 進行批准流程）：

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

群組授權（預設為限制性）：

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Owner and approval system

設定擁有者以接收當未經授權的使用者嘗試互動時的批准請求：

```json5
{
  channels: {
    tlon: {
      ownerShip: "~your-main-ship",
    },
  },
}
```

擁有者的權限是**自動在所有地方授權**的——DM 邀請會自動接受，頻道消息始終被允許。您不需要將擁有者添加到 `dmAllowlist` 或 `defaultAuthorizedShips`。

當設定後，擁有者會收到以下的 DM 通知：

- 來自不在允許清單中的船隻的 DM 請求
- 在未經授權的頻道中的提及
- 群組邀請請求

## 自動接受設定

自動接受 DM 邀請（針對 dmAllowlist 中的船隻）：

```json5
{
  channels: {
    tlon: {
      autoAcceptDmInvites: true,
    },
  },
}
```

自動接受群組邀請：

```json5
{
  channels: {
    tlon: {
      autoAcceptGroupInvites: true,
    },
  },
}
```

## 交付目標 (CLI/cron)

使用這些與 `openclaw message send` 或 cron 傳送：

- DM: `~sampel-palnet` 或 `dm/~sampel-palnet`
- Group: `chat/~host-ship/channel` 或 `group:~host-ship/channel`

## Bundled skill

Tlon 插件包含一個捆綁的技能 ([`@tloncorp/tlon-skill`](https://github.com/tloncorp/tlon-skill))，該技能提供對 Tlon 操作的 CLI 存取：

- **聯絡人**: 獲取/更新個人資料，列出聯絡人
- **頻道**: 列出、創建、發送訊息、獲取歷史紀錄
- **群組**: 列出、創建、管理成員
- **私訊**: 發送訊息、對訊息進行回應
- **反應**: 對貼文和私訊添加/移除表情符號反應
- **設定**: 通過斜線指令管理插件權限

當插件安裝後，該技能會自動可用。

## Capabilities

| 功能      | 狀態                               |
| --------- | ---------------------------------- |
| 直接訊息  | ✅ 支援                            |
| 群組/頻道 | ✅ 支援（預設需提及）              |
| 主題      | ✅ 支援（主題中的自動回覆）        |
| 富文本    | ✅ Markdown 轉換為 Tlon 格式       |
| 圖片      | ✅ 上傳至 Tlon 儲存                |
| 反應      | ✅ 透過 [捆綁技能](#bundled-skill) |
| 投票      | ❌ 尚未支援                        |
| 原生指令  | ✅ 支援（預設僅限擁有者）          |

## 故障排除

請先執行這個梯子：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
```

常見故障：

- **私訊被忽略**：發送者不在 `dmAllowlist` 中，且未為批准流程設定 `ownerShip`。
- **群組訊息被忽略**：頻道未被發現或發送者未獲授權。
- **連線錯誤**：檢查船隻 URL 是否可達；為本地船隻啟用 `allowPrivateNetwork`。
- **認證錯誤**：確認登入程式碼是否為最新（程式碼會輪換）。

## 設定參考

完整設定: [Configuration](/gateway/configuration)

Provider options:

- `channels.tlon.enabled`: 啟用/禁用頻道啟動。
- `channels.tlon.ship`: 機器人的 Urbit 船名（例如 `~sampel-palnet`）。
- `channels.tlon.url`: 船的 URL（例如 `https://sampel-palnet.tlon.network`）。
- `channels.tlon.code`: 船的登入程式碼。
- `channels.tlon.allowPrivateNetwork`: 允許 localhost/LAN URL（SSRF 繞過）。
- `channels.tlon.ownerShip`: 擁有者船隻用於批准系統（始終授權）。
- `channels.tlon.dmAllowlist`: 允許發送私訊的船隻（空 = 無）。
- `channels.tlon.autoAcceptDmInvites`: 自動接受來自白名單船隻的私訊。
- `channels.tlon.autoAcceptGroupInvites`: 自動接受所有群組邀請。
- `channels.tlon.autoDiscoverChannels`: 自動發現群組頻道（預設：真）。
- `channels.tlon.groupChannels`: 手動固定的頻道巢穴。
- `channels.tlon.defaultAuthorizedShips`: 授權所有頻道的船隻。
- `channels.tlon.authorization.channelRules`: 每個頻道的授權規則。
- `channels.tlon.showModelSignature`: 將模型名稱附加到訊息中。

## Notes

- 群組回覆需要提及（例如 `~your-bot-ship`）才能回應。
- 主題回覆：如果進來的訊息在一個主題中，OpenClaw 將在該主題中回覆。
- 富文本：Markdown 格式（粗體、斜體、程式碼、標題、列表）將轉換為 Tlon 的原生格式。
- 圖片：網址將上傳至 Tlon 儲存並嵌入為圖片區塊。
