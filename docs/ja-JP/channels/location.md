---
summary: "受信チャンネルの位置情報解析（Telegram + WhatsApp）とコンテキストフィールド"
read_when:
  - チャンネルの位置情報解析を追加・変更するとき
  - エージェントプロンプトやツールで位置情報コンテキストフィールドを使用するとき
title: "チャンネル位置情報解析"
---

# チャンネル位置情報解析

OpenClawはチャットチャンネルから共有された位置情報を以下のように正規化します:

- 受信本文に追加される人間が読めるテキスト
- 自動返信コンテキストペイロードの構造化フィールド

現在サポートされています:

- **Telegram**（ロケーションピン + ベニュー + ライブロケーション）
- **WhatsApp**（locationMessage + liveLocationMessage）
- **Matrix**（`geo_uri`を使用する`m.location`）

## テキストフォーマット

位置情報はブラケットなしのフレンドリーな行として表示されます:

- ピン:
  - `📍 48.858844, 2.294351 ±12m`
- 名前付きの場所:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- ライブ共有:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

チャンネルにキャプション/コメントが含まれる場合、次の行に追加されます:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## コンテキストフィールド

位置情報が存在する場合、以下のフィールドが`ctx`に追加されます:

- `LocationLat`（数値）
- `LocationLon`（数値）
- `LocationAccuracy`（数値、メートル。オプション）
- `LocationName`（文字列。オプション）
- `LocationAddress`（文字列。オプション）
- `LocationSource`（`pin | place | live`）
- `LocationIsLive`（ブール値）

## チャンネル固有の注意事項

- **Telegram**: ベニューは`LocationName/LocationAddress`にマッピングされます。ライブロケーションは`live_period`を使用します。
- **WhatsApp**: `locationMessage.comment`と`liveLocationMessage.caption`はキャプション行として追加されます。
- **Matrix**: `geo_uri`はピンロケーションとして解析されます。高度は無視され、`LocationIsLive`は常にfalseです。
