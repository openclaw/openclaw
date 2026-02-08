---
summary: 「入站頻道位置解析（Telegram + WhatsApp）與情境欄位」
read_when:
  - 新增或修改頻道位置解析時
  - 在代理程式提示或工具中使用位置情境欄位時
title: 「頻道位置解析」
x-i18n:
  source_path: channels/location.md
  source_hash: 5602ef105c3da7e4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:52Z
---

# 頻道位置解析

OpenClaw 會將來自聊天頻道分享的位置正規化為：

- 附加到入站內容本文中的可讀文字，以及
- 自動回覆情境負載中的結構化欄位。

目前支援：

- **Telegram**（位置釘選 + 地點 + 即時位置）
- **WhatsApp**（locationMessage + liveLocationMessage）
- **Matrix**（`m.location` 與 `geo_uri`）

## 文字格式

位置會以不含括號的友善文字行呈現：

- 釘選：
  - `📍 48.858844, 2.294351 ±12m`
- 已命名地點：
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 即時分享：
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

如果頻道包含說明文字／註解，會附加在下一行：

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## 情境欄位

當存在位置時，以下欄位會加入到 `ctx` 中：

- `LocationLat`（number）
- `LocationLon`（number）
- `LocationAccuracy`（number，公尺；選用）
- `LocationName`（string；選用）
- `LocationAddress`（string；選用）
- `LocationSource`（`pin | place | live`）
- `LocationIsLive`（boolean）

## 頻道備註

- **Telegram**：地點會對應到 `LocationName/LocationAddress`；即時位置使用 `live_period`。
- **WhatsApp**：`locationMessage.comment` 與 `liveLocationMessage.caption` 會作為說明文字行附加。
- **Matrix**：`geo_uri` 會解析為釘選位置；高度會被忽略，且 `LocationIsLive` 一律為 false。
