---
summary: "入站頻道位置解析 (Telegram + WhatsApp) 與內容欄位"
read_when:
  - "新增或修改頻道位置解析時"
  - "在智慧代理提示詞或工具中使用位置內容欄位時"
title: "頻道位置解析"
---

# 頻道位置解析

OpenClaw 將通訊頻道分享的位置標準化為：

- 附加在入站本文後的易讀文字，以及
- 自動回覆內容負載（payload）中的結構化欄位。

目前支援：

- **Telegram** (位置圖釘 + 地點 + 即時位置)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (帶有 `geo_uri` 的 `m.location`)

## 文字格式化

位置會以易於閱讀且不含括號的行式呈現：

- 圖釘：
  - `📍 48.858844, 2.294351 ±12m`
- 具名地點：
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 即時分享：
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

如果頻道包含說明/評論，它將附加在下一行：

```
📍 48.858844, 2.294351 ±12m
在這裡見面
```

## 內容欄位

當存在位置時，這些欄位會被新增至 `ctx`：

- `LocationLat` (數字)
- `LocationLon` (數字)
- `LocationAccuracy` (數字，公尺；選填)
- `LocationName` (字串；選填)
- `LocationAddress` (字串；選填)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (布林值)

## 頻道注意事項

- **Telegram**：地點（venues）對應至 `LocationName`/`LocationAddress`；即時位置使用 `live_period`。
- **WhatsApp**：`locationMessage.comment` 和 `liveLocationMessage.caption` 會作為說明行附加。
- **Matrix**：`geo_uri` 被解析為圖釘位置；海拔高度會被忽略，且 `LocationIsLive` 永遠為 false。
