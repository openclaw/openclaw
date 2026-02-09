---
read_when:
  - 添加或修改渠道位置解析
  - 在智能体提示或工具中使用位置上下文字段
summary: 入站渠道位置解析（Telegram + WhatsApp）及上下文字段
title: 渠道位置解析
x-i18n:
  generated_at: "2026-02-01T19:21:46Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 5602ef105c3da7e47497bfed8fc343dd8d7f3c019ff7e423a08b25092c5a1837
  source_path: channels/location.md
  workflow: 14
---

# 渠道位置解析

OpenClaw 将聊天渠道中分享的位置标准化为：

- 附加到入站消息体的可读文本，以及
- 自动回复上下文负载中的结构化字段。

目前支持：

- **Telegram**（位置图钉 + 地点 + 实时位置）
- **WhatsApp**（locationMessage + liveLocationMessage）
- **Matrix**（`m.location` 配合 `geo_uri`）

## 文本格式

位置以友好的行格式呈现，不带括号：

- 图钉：
  - `📍 48.858844, 2.294351 ±12m`
- 命名地点：
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 实时分享：
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

如果渠道包含标题/评论，会附加在下一行：

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## 上下文字段

当存在位置信息时，以下字段会被添加到 `ctx` 中：

- `LocationLat`（数字）
- `LocationLon`（数字）
- `LocationAccuracy`（数字，米；可选）
- `LocationName`（字符串；可选）
- `LocationAddress`（字符串；可选）
- `LocationSource`（`pin | place | live`）
- `LocationIsLive`（布尔值）

## 渠道说明

- **Telegram**：地点映射到 `LocationName/LocationAddress`；实时位置使用 `live_period`。
- **WhatsApp**：`locationMessage.comment` 和 `liveLocationMessage.caption` 作为标题行附加。
- **Matrix**：`geo_uri` 解析为图钉位置；忽略海拔高度，`LocationIsLive` 始终为 false。
