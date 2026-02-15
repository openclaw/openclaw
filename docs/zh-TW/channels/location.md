```
---
summary: "入站頻道位置解析（Telegram + WhatsApp）和上下文欄位"
read_when:
  - 新增或修改頻道位置解析
  - 在智慧代理提示或工具中使用位置上下文欄位
title: "頻道位置解析"
---

# 頻道位置解析

OpenClaw 將聊天頻道中共享的位置正規化為：

- 附加到入站訊息主體的易讀文字，以及
- 自動回覆上下文酬載中的結構化欄位。

目前支援：

- **Telegram** (位置圖釘 + 場地 + 即時位置)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` 帶有 `geo_uri`)

## 文字格式

位置以不帶括號的友善行顯示：

- 圖釘：
  - `📍 48.858844, 2.294351 ±12m`
- 命名地點：
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 即時共享：
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

如果頻道包含說明/評論，它將附加在下一行：

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## 上下文欄位

當存在位置時，這些欄位將新增到 `ctx`：

- `LocationLat` (數字)
- `LocationLon` (數字)
- `LocationAccuracy` (數字，公尺；可選)
- `LocationName` (字串；可選)
- `LocationAddress` (字串；可選)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (布林值)

## 頻道注意事項

- **Telegram**：場地映射到 `LocationName/LocationAddress`；即時位置使用 `live_period`。
- **WhatsApp**：`locationMessage.comment` 和 `liveLocationMessage.caption` 作為說明行附加。
- **Matrix**：`geo_uri` 被解析為圖釘位置；海拔高度被忽略，且 `LocationIsLive` 始終為 false。
```
