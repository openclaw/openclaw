---
summary: Inbound channel location parsing (Telegram + WhatsApp) and context fields
read_when:
  - Adding or modifying channel location parsing
  - Using location context fields in agent prompts or tools
title: Channel Location Parsing
---

# Channel location parsing

OpenClaw 將聊天頻道中的共享位置標準化為：

- 附加到進入主體的可讀人類文本，以及
- 自動回覆上下文有效載荷中的結構化欄位。

目前支援：

- **Telegram** (位置釘 + 場地 + 實時位置)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` 與 `geo_uri`)

## Text formatting

[[BLOCK_1]]  
Locations are rendered as friendly lines without brackets:  
[[INLINE_1]]

- Pin:
  - `📍 48.858844, 2.294351 ±12m`
- Named place:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Live share:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

如果頻道包含標題/註解，則會附加在下一行：

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Context fields

當位置存在時，這些欄位會被添加到 `ctx`：

- `LocationLat` (數字)
- `LocationLon` (數字)
- `LocationAccuracy` (數字，公尺；可選)
- `LocationName` (字串；可選)
- `LocationAddress` (字串；可選)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (布林值)

## Channel notes

- **Telegram**: 場地對應到 `LocationName/LocationAddress`; 實時位置使用 `live_period`。
- **WhatsApp**: `locationMessage.comment` 和 `liveLocationMessage.caption` 被附加為標題行。
- **Matrix**: `geo_uri` 被解析為釘選位置；高度被忽略，且 `LocationIsLive` 始終為假。
