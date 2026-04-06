---
read_when:
    - IPCコントラクトやメニューバーアプリのIPCを編集する場合
summary: OpenClawアプリ、Gateway ゲートウェイノードトランスポート、PeekabooBridgeのmacOS IPCアーキテクチャ
title: macOS IPC
x-i18n:
    generated_at: "2026-04-02T08:34:30Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d0211c334a4a59b71afb29dd7b024778172e529fa618985632d3d11d795ced92
    source_path: platforms/mac/xpc.md
    workflow: 15
---

# OpenClaw macOS IPCアーキテクチャ

**現在のモデル:** ローカルUnixソケットが**ノードホストサービス**と**macOSアプリ**を接続し、exec承認と`system.run`を処理します。`openclaw-mac`デバッグCLIはディスカバリー/接続チェック用に存在します。エージェントアクションは引き続きGateway ゲートウェイWebSocketと`node.invoke`を経由します。UI自動化にはPeekabooBridgeを使用します。

## 目標

- すべてのTCC関連処理（通知、画面録画、マイク、音声、AppleScript）を管理する単一のGUIアプリインスタンス。
- 自動化のための小さなサーフェス: Gateway ゲートウェイ + ノードコマンド、およびUI自動化用のPeekabooBridge。
- 予測可能な権限: 常に同じ署名済みバンドルIDで、launchdによって起動されるため、TCC許可が維持されます。

## 仕組み

### Gateway ゲートウェイ + ノードトランスポート

- アプリはGateway ゲートウェイ（ローカルモード）を実行し、ノードとして接続します。
- エージェントアクションは`node.invoke`（例: `system.run`、`system.notify`、`canvas.*`）を介して実行されます。

### ノードサービス + アプリIPC

- ヘッドレスノードホストサービスがGateway ゲートウェイWebSocketに接続します。
- `system.run`リクエストはローカルUnixソケットを介してmacOSアプリに転送されます。
- アプリはUIコンテキストでexecを実行し、必要に応じてプロンプトを表示し、出力を返します。

図（SCI）:

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge（UI自動化）

- UI自動化は`bridge.sock`という名前の別のUNIXソケットとPeekabooBridge JSONプロトコルを使用します。
- ホスト優先順位（クライアント側）: Peekaboo.app → Claude.app → OpenClaw.app → ローカル実行。
- セキュリティ: ブリッジホストは許可されたTeamIDを必要とします。DEBUGのみの同一UID回避策は`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（Peekaboo規約）で保護されています。
- 詳細は[PeekabooBridgeの使い方](/platforms/mac/peekaboo)を参照してください。

## 運用フロー

- 再起動/リビルド: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 既存のインスタンスを終了
  - Swiftビルド + パッケージ
  - LaunchAgentの書き込み/ブートストラップ/キックスタート
- 単一インスタンス: 同じバンドルIDの別のインスタンスが実行中の場合、アプリは早期終了します。

## セキュリティ強化に関する注意事項

- すべての特権サーフェスでTeamIDの一致を要求することを推奨します。
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（DEBUGのみ）は、ローカル開発のために同一UIDの呼び出し元を許可する場合があります。
- すべての通信はローカルのみで行われ、ネットワークソケットは公開されません。
- TCCプロンプトはGUIアプリバンドルからのみ発生します。リビルド間で署名済みバンドルIDを安定させてください。
- IPC強化: ソケットモード`0600`、トークン、ピアUIDチェック、HMACチャレンジ/レスポンス、短いTTL。
