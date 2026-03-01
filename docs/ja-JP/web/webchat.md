---
summary: "ループバック WebChat の静的ホストとチャット UI 用の Gateway WebSocket の使用"
read_when:
  - WebChat アクセスのデバッグや設定を行う場合
title: "WebChat"
---

# WebChat（Gateway WebSocket UI）

ステータス: macOS/iOS の SwiftUI チャット UI は Gateway WebSocket に直接接続します。

## 概要

- Gateway 用のネイティブチャット UI です（埋め込みブラウザもローカル静的サーバーも不要）。
- 他のチャンネルと同じセッションとルーティングルールを使用します。
- 決定論的ルーティング: 返信は常に WebChat に戻ります。

## クイックスタート

1. Gateway を起動します。
2. WebChat UI（macOS/iOS アプリ）またはコントロール UI のチャットタブを開きます。
3. Gateway 認証が設定されていることを確認します（デフォルトで必須。ループバックでも同様）。

## 動作の仕組み

- UI は Gateway WebSocket に接続し、`chat.history`、`chat.send`、`chat.inject` を使用します。
- `chat.history` は安定性のために制限されています。Gateway は長いテキストフィールドを切り詰め、重いメタデータを省略し、サイズオーバーのエントリを `[chat.history omitted: message too large]` で置き換えることがあります。
- `chat.inject` はアシスタントのノートをトランスクリプトに直接追加し、UI にブロードキャストします（エージェントの実行は行われません）。
- アボートされた実行では、部分的なアシスタント出力が UI に引き続き表示されることがあります。
- バッファされた出力が存在する場合、Gateway はアボートされた部分的なアシスタントテキストをトランスクリプト履歴に保存し、それらのエントリにアボートメタデータを付与します。
- 履歴は常に Gateway から取得されます（ローカルファイルの監視はありません）。
- Gateway に到達できない場合、WebChat は読み取り専用になります。

## コントロール UI のエージェントツールパネル

- コントロール UI の `/agents` ツールパネルは、`tools.catalog` 経由でランタイムカタログを取得し、各ツールを `core` または `plugin:<id>`（オプションのプラグインツールには `optional`）としてラベル付けします。
- `tools.catalog` が利用できない場合、パネルは組み込みの静的リストにフォールバックします。
- パネルはプロファイルとオーバーライドの設定を編集しますが、実効的なランタイムアクセスはポリシーの優先順位（`allow`/`deny`、エージェントごとおよびプロバイダー/チャンネルごとのオーバーライド）に従います。

## リモート使用

- リモートモードでは、Gateway WebSocket を SSH/Tailscale 経由でトンネリングします。
- 別途 WebChat サーバーを実行する必要はありません。

## 設定リファレンス（WebChat）

完全な設定: [設定](/gateway/configuration)

チャンネルオプション:

- 専用の `webchat.*` ブロックはありません。WebChat は以下の Gateway エンドポイントと認証設定を使用します。

関連するグローバルオプション:

- `gateway.port`、`gateway.bind`: WebSocket のホスト/ポート。
- `gateway.auth.mode`、`gateway.auth.token`、`gateway.auth.password`: WebSocket 認証（トークン/パスワード）。
- `gateway.auth.mode: "trusted-proxy"`: ブラウザクライアント用のリバースプロキシ認証（[トラステッドプロキシ認証](/gateway/trusted-proxy-auth) を参照）。
- `gateway.remote.url`、`gateway.remote.token`、`gateway.remote.password`: リモート Gateway ターゲット。
- `session.*`: セッションストレージとメインキーのデフォルト。
