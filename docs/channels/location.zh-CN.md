---
summary: "入站通道位置解析（Telegram/WhatsApp/Matrix）和上下文字段"
read_when:
  - 添加或修改通道位置解析
  - 在代理提示或工具中使用位置上下文字段
title: "通道位置解析"
---

# 通道位置解析

OpenClaw 将聊天通道共享的位置标准化为：

- 附加到入站正文的人类可读文本，以及
- 自动回复上下文有效负载中的结构化字段。

当前支持：

- **Telegram**（位置 pin + 场所 + 实时位置）
- **WhatsApp**（locationMessage + liveLocationMessage）
- **Matrix**（带有 `geo_uri` 的 `m.location`）

## 文本格式

位置以友好的行形式呈现，不带括号：

- 位置 pin：
  - `📍 48.858844, 2.294351 ±12m`
- 命名地点：
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 实时共享：
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

如果通道包含标题/评论，它会在下一行附加：

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## 上下文字段

当存在位置时，这些字段会添加到 `ctx`：

- `LocationLat`（数字）
- `LocationLon`（数字）
- `LocationAccuracy`（数字，米；可选）
- `LocationName`（字符串；可选）
- `LocationAddress`（字符串；可选）
- `LocationSource`（`pin | place | live`）
- `LocationIsLive`（布尔值）

## 通道说明

- **Telegram**：场所映射到 `LocationName/LocationAddress`；实时位置使用 `live_period`。
- **WhatsApp**：`locationMessage.comment` 和 `liveLocationMessage.caption` 作为标题行附加。
- **Matrix**：`geo_uri` 被解析为 pin 位置；忽略高度，`LocationIsLive` 始终为 false。