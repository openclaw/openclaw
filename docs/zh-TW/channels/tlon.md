---
summary: "Tlon/Urbit 支援狀態、功能與設定"
read_when:
  - 開發 Tlon/Urbit 頻道功能時
title: "Tlon"
---

# Tlon (外掛程式)

Tlon 是建立在 Urbit 之上的去中心化通訊軟體。OpenClaw 會連接到您的 Urbit ship，並可回應私訊 (DMs) 與群組聊天訊息。群組回覆預設需要 @ 提及 (mention)，並可透過允許清單進一步限制。

狀態：透過外掛程式支援。支援私訊、群組提及、執行緒回覆，以及純文字媒體備援 (URL 會附加到說明文字中)。不支援表情回應 (Reactions)、投票 (polls) 與原生媒體上傳。

## 需要外掛程式

Tlon 以外掛程式形式提供，未包含在核心安裝包中。

透過 CLI 安裝 (npm 登錄檔)：

```bash
openclaw plugins install @openclaw/tlon
```

本地端檢出 (從 git 存放庫執行時)：

```bash
openclaw plugins install ./extensions/tlon
```

詳情請見：[Plugins](/tools/plugin)

## 設定

1. 安裝 Tlon 外掛程式。
2. 取得您的 ship URL 與登入代碼。
3. 設定 `channels.tlon`。
4. 重啟 Gateway。
5. 私訊智慧代理或在群組頻道中提及它。

基本設定 (單一帳號)：

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## 群組頻道

預設啟用自動探索。您也可以手動固定頻道：

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

停用自動探索：

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

私訊允許清單 (留空 = 允許所有)：

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

群組授權 (預設為受限)：

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

## 傳送目標 (CLI/cron)

搭配 `openclaw message send` 或 cron 傳送使用：

- 私訊：`~sampel-palnet` 或 `dm/~sampel-palnet`
- 群組：`chat/~host-ship/channel` 或 `group:~host-ship/channel`

## 注意事項

- 群組回覆需要提及 (例如 `~your-bot-ship`) 才會回應。
- 執行緒回覆：若傳入訊息位於執行緒中，OpenClaw 會在該執行緒內回覆。
- 媒體：`sendMedia` 會備援為文字 + URL (無原生上傳)。
