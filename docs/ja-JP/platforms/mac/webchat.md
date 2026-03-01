---
summary: "macアプリがGateway WebChatを埋め込む方法とデバッグ方法"
read_when:
  - mac WebChatビューまたはループバックポートのデバッグ
title: "WebChat"
---

# WebChat（macOSアプリ）

macOSメニューバーアプリはWebChat UIをネイティブSwiftUIビューとして埋め込みます。Gatewayに接続し、選択されたエージェントの**メインセッション**をデフォルトとします（他のセッション用のセッションスイッチャー付き）。

- **ローカルモード**：ローカルGateway WebSocketに直接接続します。
- **リモートモード**：SSH経由でGatewayコントロールポートを転送し、そのトンネルをデータプレーンとして使用します。

## 起動とデバッグ

- 手動：Lobsterメニュー → 「Open Chat」。
- テスト用の自動オープン：

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- ログ：`./scripts/clawlog.sh`（サブシステム`ai.openclaw`、カテゴリ`WebChatSwiftUI`）。

## 接続の仕組み

- データプレーン：Gateway WSメソッド`chat.history`、`chat.send`、`chat.abort`、`chat.inject`およびイベント`chat`、`agent`、`presence`、`tick`、`health`。
- セッション：プライマリセッション（`main`、またはスコープがグローバルの場合は`global`）をデフォルトとします。UIでセッション間を切り替えられます。
- オンボーディングは初回セットアップを分離するために専用セッションを使用します。

## セキュリティサーフェス

- リモートモードはSSH経由でGateway WebSocketコントロールポートのみを転送します。

## 既知の制限事項

- UIはチャットセッション用に最適化されています（完全なブラウザサンドボックスではありません）。
