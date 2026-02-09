---
summary: "Loopback WebChat の静的ホストおよびチャット UI 向けの Gateway WebSocket 利用"
read_when:
  - WebChat アクセスのデバッグまたは設定時
title: "WebChat"
---

# WebChat（Gateway WebSocket UI）

ステータス：macOS/iOS の SwiftUI チャット UI は、Gateway WebSocket と直接通信します。

## これは何か

- ゲートウェイ向けのネイティブなチャット UI です（埋め込みブラウザーやローカルの静的サーバーは不要）。
- 他のチャンネルと同じセッションおよびルーティングルールを使用します。
- 決定的ルーティング：返信は常に WebChat に戻ります。

## クイックスタート

1. ゲートウェイを起動します。
2. WebChat UI（macOS/iOS アプリ）または Control UI のチャットタブを開きます。
3. ゲートウェイの認証が設定されていることを確認します（loopback であっても、既定では必須です）。

## 動作の仕組み（挙動）

- UI は Gateway WebSocket に接続し、`chat.history`、`chat.send`、`chat.inject` を使用します。
- `chat.inject` は、アシスタントの注記をトランスクリプトに直接追加し、UI にブロードキャストします（エージェント実行は行いません）。
- 履歴は常にゲートウェイから取得されます（ローカルファイルの監視は行いません）。
- ゲートウェイに到達できない場合、WebChat は読み取り専用になります。

## リモート利用

- リモートモードでは、ゲートウェイの WebSocket を SSH/Tailscale 経由でトンネルします。
- 別途 WebChat サーバーを起動する必要はありません。

## 設定リファレンス（WebChat）

完全な設定： [Configuration](/gateway/configuration)

チャンネルオプション：

- 専用の `webchat.*` ブロックはありません。WebChat は、以下のゲートウェイエンドポイントおよび認証設定を使用します。 WebChatは以下のゲートウェイエンドポイント+認証設定を使用します。

関連するグローバルオプション：

- `gateway.port`、`gateway.bind`：WebSocket のホスト／ポート。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`：WebSocket 認証。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`：リモートゲートウェイのターゲット。
- `session.*`：セッションストレージおよびメインキーの既定値。
