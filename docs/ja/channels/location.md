---
summary: "チャットチャンネルからの受信位置情報の解析（Telegram + WhatsApp）とコンテキストフィールド"
read_when:
  - チャンネルの位置情報解析を追加または変更する場合
  - エージェントのプロンプトやツールで位置情報のコンテキストフィールドを使用する場合
title: "チャンネルの位置情報解析"
x-i18n:
  source_path: channels/location.md
  source_hash: 5602ef105c3da7e4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:20:44Z
---

# チャンネルの位置情報解析

OpenClaw は、チャットチャンネルで共有された位置情報を次の形式に正規化します。

- 受信本文に追記される、人が読みやすいテキスト
- 自動返信のコンテキストペイロードに含まれる構造化フィールド

現在サポートされているチャンネルは次のとおりです。

- **Telegram**（位置ピン、会場、ライブ位置情報）
- **WhatsApp**（locationMessage、liveLocationMessage）
- **Matrix**（`m.location` と `geo_uri`）

## テキスト形式

位置情報は、角括弧を使用しない分かりやすい行としてレンダリングされます。

- ピン:
  - `📍 48.858844, 2.294351 ±12m`
- 名前付きの場所:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- ライブ共有:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

チャンネルにキャプションやコメントが含まれている場合は、次の行に追記されます。

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## コンテキストフィールド

位置情報が存在する場合、次のフィールドが `ctx` に追加されます。

- `LocationLat`（数値）
- `LocationLon`（数値）
- `LocationAccuracy`（数値、メートル；任意）
- `LocationName`（文字列；任意）
- `LocationAddress`（文字列；任意）
- `LocationSource`（`pin | place | live`）
- `LocationIsLive`（真偽値）

## チャンネル別の注記

- **Telegram**: 会場は `LocationName/LocationAddress` にマップされます。ライブ位置情報は `live_period` を使用します。
- **WhatsApp**: `locationMessage.comment` と `liveLocationMessage.caption` はキャプション行として追記されます。
- **Matrix**: `geo_uri` はピン位置として解析されます。高度は無視され、`LocationIsLive` は常に false です。
