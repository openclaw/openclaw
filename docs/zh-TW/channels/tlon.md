---
summary: "Tlon/Urbit 支援狀態、功能與設定"
read_when:
  - 在 Tlon/Urbit 頻道功能上作業時
title: "Tlon"
---

# Tlon (外掛程式)

Tlon 是一個基於 Urbit 建構的去中心化訊息應用程式。OpenClaw 會連接您的 Urbit ship，並能
回應私訊和群組聊天訊息。群組回覆預設需要 @ 提及，並可透過允許清單進一步限制。

狀態：透過外掛程式支援。支援私訊、群組提及、串流回覆以及僅限文字的媒體備援 (URL 附加到說明)。
不支援反應、投票和原生媒體上傳。

## 需要外掛程式

Tlon 以外掛程式形式發布，未與核心安裝捆綁。

透過 CLI (npm registry) 安裝：

```bash
openclaw plugins install @openclaw/tlon
```

本機檢出（從 Git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/tlon
```

詳情：[外掛程式](/tools/plugin)

## 設定

1. 安裝 Tlon 外掛程式。
2. 收集您的 ship URL 和登入碼。
3. 設定 `channels.tlon`。
4. 重新啟動 Gateway。
5. 私訊機器人或在群組頻道中提及它。

最小設定（單一帳戶）：

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

自動探索預設為啟用。您也可以手動釘選頻道：

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

私訊允許清單（空白 = 允許所有）：

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

群組授權（預設為受限）：

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

搭配 `openclaw message send` 或 cron 傳送使用這些設定：

- 私訊：`~sampel-palnet` 或 `dm/~sampel-palnet`
- 群組：`chat/~host-ship/channel` 或 `group:~host-ship/channel`

## 備註

- 群組回覆需要提及（例如 `~your-bot-ship`）才能回應。
- 串流回覆：如果入站訊息位於串流中，OpenClaw 會在串流中回覆。
- 媒體：`sendMedia` 會備援為文字 + URL（無原生上傳）。
