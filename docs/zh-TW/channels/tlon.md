---
summary: "Tlon／Urbit 的支援狀態、功能與設定"
read_when:
  - 進行 Tlon／Urbit 頻道功能開發時
title: "Tlon"
---

# Tlon（外掛）

6. Tlon 是一個建立在 Urbit 上的去中心化即時通訊軟體。 7. OpenClaw 會連接到你的 Urbit ship，並且可以
   回應私訊與群組聊天訊息。 8. 群組回覆預設需要 @ 提及，且可以
   透過允許清單進一步限制。

9. 狀態：透過外掛支援。 10. 私訊、群組提及、串內回覆，以及僅文字的媒體備援
   （URL 會附加在說明文字後）。 11. 不支援表情反應、投票與原生媒體上傳。

## 12. 需要外掛

Tlon 以外掛形式提供，未隨核心安裝一併提供。

透過 CLI 安裝（npm 登錄）：

```bash
openclaw plugins install @openclaw/tlon
```

本機檢出（從 git repo 執行時）：

```bash
openclaw plugins install ./extensions/tlon
```

詳細資訊：[Plugins](/tools/plugin)

## 設定

1. 13. 安裝 Tlon 外掛。
2. 蒐集你的船艦 URL 與登入碼。
3. 設定 `channels.tlon`。
4. 重新啟動 Gateway 閘道器。
5. 14. 私訊機器人，或在群組頻道中提及它。

最小設定（單一帳號）：

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

15. 自動探索預設為啟用。 16. 你也可以手動釘選頻道：

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

私訊允許清單（空白＝全部允許）：

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

群組授權（預設為限制）：

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

## 傳送目標（CLI／cron）

搭配 `openclaw message send` 或 cron 傳送使用：

- 私訊：`~sampel-palnet` 或 `dm/~sampel-palnet`
- 群組：`chat/~host-ship/channel` 或 `group:~host-ship/channel`

## 注意事項

- 群組回覆需要提及（例如 `~your-bot-ship`）才會回應。
- 串內回覆：若傳入訊息位於討論串中，OpenClaw 會在串內回覆。
- 媒體：`sendMedia` 會退回為文字＋URL（不支援原生上傳）。
