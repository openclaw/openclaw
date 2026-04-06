---
read_when:
    - macのWebChatビューやlocal loopbackポートをデバッグする場合
summary: macアプリがGateway ゲートウェイのWebChatをどのように埋め込み、デバッグするか
title: WebChat（macOS）
x-i18n:
    generated_at: "2026-04-02T07:48:23Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a213fb3492af39ef7b30cd5317f349879dda324736f893798c84b21a7f29618a
    source_path: platforms/mac/webchat.md
    workflow: 15
---

# WebChat（macOSアプリ）

macOSメニューバーアプリはWebChat UIをネイティブのSwiftUIビューとして埋め込みます。Gateway ゲートウェイに接続し、選択したエージェントの**メインセッション**をデフォルトとします（他のセッション用のセッション切り替え機能あり）。

- **ローカルモード**: ローカルのGateway ゲートウェイWebSocketに直接接続します。
- **リモートモード**: SSH経由でGateway ゲートウェイのコントロールポートを転送し、そのトンネルをデータプレーンとして使用します。

## 起動とデバッグ

- 手動: Lobsterメニュー →「Open Chat」。
- テスト用の自動オープン:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- ログ: `./scripts/clawlog.sh`（サブシステム `ai.openclaw`、カテゴリ `WebChatSwiftUI`）。

## 接続の仕組み

- データプレーン: Gateway ゲートウェイWSメソッド `chat.history`、`chat.send`、`chat.abort`、
  `chat.inject` およびイベント `chat`、`agent`、`presence`、`tick`、`health`。
- セッション: プライマリセッション（`main`、スコープがグローバルの場合は `global`）がデフォルトです。UIでセッション間を切り替えることができます。
- オンボーディングは初回セットアップを分離するために専用セッションを使用します。

## セキュリティサーフェス

- リモートモードではSSH経由でGateway ゲートウェイWebSocketのコントロールポートのみを転送します。

## 既知の制限事項

- UIはチャットセッション用に最適化されています（完全なブラウザサンドボックスではありません）。
