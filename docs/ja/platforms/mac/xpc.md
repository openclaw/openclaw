---
summary: "OpenClaw アプリ、ゲートウェイ ノードのトランスポート、および PeekabooBridge 向けの macOS IPC アーキテクチャ"
read_when:
  - IPC コントラクトまたはメニューバー アプリの IPC を編集する場合
title: "macOS IPC"
---

# OpenClaw macOS IPC アーキテクチャ

**現在のモデル:** ローカル Unix ソケットが **ノード ホスト サービス** を **macOS アプリ** に接続し、実行承認 + `system.run` を提供します。検出／接続チェック用に `openclaw-mac` デバッグ CLI が存在します。エージェントのアクションは引き続き Gateway WebSocket と `node.invoke` を経由します。UI 自動化には PeekabooBridge を使用します。 チェックを発見/接続するための `openclaw-mac` デバッグCLI が存在します。エージェントアクションはゲートウェイの WebSocket と `node.invoke` を流れます。 UIオートメーションはPeekabooBridgeを使用しています。

## 目標

- TCC 対応の作業（通知、画面収録、マイク、音声、AppleScript）をすべて所有する単一の GUI アプリ インスタンス。
- 自動化のための小さな表面積: Gateway + ノード コマンドに加え、UI 自動化用の PeekabooBridge。
- 予測可能な権限: 常に同一の署名済みバンドル ID を使用し、launchd により起動されるため、TCC の付与が維持されます。

## How it works

### Gateway + ノード トランスポート

- アプリは Gateway（ローカル モード）を実行し、ノードとしてそれに接続します。
- エージェントのアクションは `node.invoke`（例: `system.run`、`system.notify`、`canvas.*`）を介して実行されます。

### ノード サービス + アプリ IPC

- ヘッドレスのノード ホスト サービスが Gateway WebSocket に接続します。
- `system.run` のリクエストは、ローカル Unix ソケットを介して macOS アプリに転送されます。
- アプリは UI コンテキストで実行を行い、必要に応じてプロンプトを表示し、出力を返します。

図（SCI）:

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge（UI 自動化）

- UI 自動化は、`bridge.sock` という名前の別個の UNIX ソケットと PeekabooBridge JSON プロトコルを使用します。
- ホストの優先順位（クライアント側）: Peekaboo.app → Claude.app → OpenClaw.app → ローカル実行。
- セキュリティ: ブリッジ ホストには許可された TeamID が必要です。DEBUG 専用の同一 UID エスケープ ハッチは `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（Peekaboo の規約）により保護されています。
- 詳細は [PeekabooBridge の使用方法](/platforms/mac/peekaboo) を参照してください。

## 運用フロー

- 再起動／再ビルド: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 既存インスタンスの終了
  - Swift のビルド + パッケージング
  - LaunchAgent の書き込み／ブートストラップ／キックスタート
- 単一インスタンス: 同一のバンドル ID を持つ別インスタンスが実行中の場合、アプリは早期に終了します。

## ハードニングに関する注記

- すべての特権サーフェスで TeamID の一致を必須にすることを推奨します。
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（DEBUG 専用）は、ローカル開発向けに同一 UID の呼び出し元を許可する場合があります。
- すべての通信はローカル専用のままであり、ネットワーク ソケットは公開されません。
- TCC プロンプトは GUI アプリ バンドルからのみ発生します。再ビルド間で署名済みバンドル ID を安定させてください。
- IPC のハードニング: ソケット モード `0600`、トークン、ピア UID チェック、HMAC チャレンジ／レスポンス、短い TTL。
