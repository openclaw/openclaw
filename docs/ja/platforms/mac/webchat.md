---
summary: "mac アプリが Gateway WebChat を埋め込む方法と、そのデバッグ方法"
read_when:
  - mac WebChat ビューやループバックポートのデバッグ時
title: "WebChat"
---

# WebChat（macOS アプリ）

macOS のメニューバーアプリは、WebChat UI をネイティブな SwiftUI ビューとして埋め込みます。Gateway（ゲートウェイ）に接続し、選択したエージェントの **メインセッション** をデフォルトで使用します（他のセッションに切り替えるためのセッションスイッチャーがあります）。
はゲートウェイに接続し、デフォルトでは選択された
エージェントの**メインセッション**になります (他のセッションのセッションスイッチャー付き)。

- **ローカルモード**：ローカルの Gateway WebSocket に直接接続します。
- **リモートモード**：Gateway のコントロールポートを SSH 経由でフォワードし、そのトンネルをデータプレーンとして使用します。

## 起動とデバッグ

- 手動：Lobster メニュー → 「Open Chat」。

- テスト用の自動オープン：

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- ログ：`./scripts/clawlog.sh`（サブシステム `bot.molt`、カテゴリ `WebChatSwiftUI`）。

## 配線の仕組み

- データプレーン：Gateway WS メソッド `chat.history`、`chat.send`、`chat.abort`、
  `chat.inject` と、イベント `chat`、`agent`、`presence`、`tick`、`health`。
- セッション：デフォルトはプライマリセッション（`main`、スコープがグローバルの場合は `global`）です。UI からセッションを切り替えられます。 UIはセッションを切り替えることができます。
- オンボーディングでは、初回実行時のセットアップを分離するために専用のセッションを使用します。

## セキュリティの対象範囲

- リモートモードでは、Gateway WebSocket のコントロールポートのみを SSH 経由でフォワードします。

## 既知の制限

- UI はチャットセッション向けに最適化されています（完全なブラウザーサンドボックスではありません）。
