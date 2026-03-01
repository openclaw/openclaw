---
summary: "OpenClawアプリ、Gatewayノードトランスポート、PeekabooBridgeのmacOS IPCアーキテクチャ"
read_when:
  - IPCコントラクトまたはメニューバーアプリIPCの編集
title: "macOS IPC"
---

# OpenClaw macOS IPCアーキテクチャ

**現在のモデル：** ローカルUnixソケットが**ノードホストサービス**と**macOSアプリ**を接続し、exec承認と`system.run`を処理します。`openclaw-mac`デバッグCLIはディスカバリー/接続チェック用に存在します。エージェントアクションは引き続きGateway WebSocketと`node.invoke`を通じて流れます。UIオートメーションはPeekabooBridgeを使用します。

## 目標

- すべてのTCC対象作業（通知、画面収録、マイク、音声認識、AppleScript）を所有する単一GUIアプリインスタンス。
- オートメーション用の小さなサーフェス：Gateway + ノードコマンド、およびUIオートメーション用のPeekabooBridge。
- 予測可能なパーミッション：常に同じ署名済みバンドルID、launchdによる起動、これによりTCC付与が保持されます。

## 仕組み

### Gateway + ノードトランスポート

- アプリはGateway（ローカルモード）を実行し、ノードとしてそれに接続します。
- エージェントアクションは`node.invoke`（例：`system.run`、`system.notify`、`canvas.*`）を介して実行されます。

### ノードサービス + アプリIPC

- ヘッドレスノードホストサービスがGateway WebSocketに接続します。
- `system.run`リクエストはローカルUnixソケットを介してmacOSアプリに転送されます。
- アプリはUIコンテキストでexecを実行し、必要に応じてプロンプトを表示し、出力を返します。

図（SCI）：

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge（UIオートメーション）

- UIオートメーションは`bridge.sock`という名前の別のUNIXソケットとPeekabooBridge JSONプロトコルを使用します。
- ホスト優先順位（クライアント側）：Peekaboo.app → Claude.app → OpenClaw.app → ローカル実行。
- セキュリティ：ブリッジホストは許可されたTeamIDを要求します。DEBUGのみの同一UIDエスケープハッチは`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（Peekabooの慣例）によってガードされます。
- 詳細は[PeekabooBridgeの使用方法](/platforms/mac/peekaboo)を参照してください。

## 運用フロー

- 再起動/リビルド：`SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 既存のインスタンスをkill
  - Swiftビルド + パッケージング
  - LaunchAgentの書き込み/ブートストラップ/キックスタート
- シングルインスタンス：同じバンドルIDの別のインスタンスが実行中の場合、アプリは早期終了します。

## セキュリティ強化に関する注意事項

- すべての特権サーフェスに対してTeamIDの一致を要求することを推奨します。
- PeekabooBridge：`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（DEBUGのみ）は、ローカル開発時に同一UIDの呼び出し元を許可する場合があります。
- すべての通信はローカルのみです。ネットワークソケットは公開されません。
- TCCプロンプトはGUIアプリバンドルからのみ発生します。リビルド間で署名済みバンドルIDを安定させてください。
- IPCセキュリティ強化：ソケットモード`0600`、トークン、ピアUIDチェック、HMACチャレンジ/レスポンス、短いTTL。
