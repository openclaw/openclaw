---
summary: "macOS UIオートメーション用PeekabooBridge統合"
read_when:
  - OpenClaw.appでのPeekabooBridgeのホスティング
  - Swift Package ManagerによるPeekabooの統合
  - PeekabooBridgeプロトコル/パスの変更
title: "Peekaboo Bridge"
---

# Peekaboo Bridge（macOS UIオートメーション）

OpenClawはローカルのパーミッション対応UIオートメーションブローカーとして**PeekabooBridge**をホストできます。これにより、`peekaboo` CLIがmacOSアプリのTCCパーミッションを再利用してUIオートメーションを実行できます。

## これは何か（何でないか）

- **ホスト**：OpenClaw.appはPeekabooBridgeホストとして機能できます。
- **クライアント**：`peekaboo` CLIを使用します（別途`openclaw ui ...`サーフェスはありません）。
- **UI**：ビジュアルオーバーレイはPeekaboo.appに残ります。OpenClawは薄いブローカーホストです。

## ブリッジの有効化

macOSアプリで：

- Settings → **Enable Peekaboo Bridge**

有効にすると、OpenClawはローカルUNIXソケットサーバーを起動します。無効にすると、ホストは停止し、`peekaboo`は他の利用可能なホストにフォールバックします。

## クライアントの検出順序

Peekabooクライアントは通常、以下の順序でホストを試します：

1. Peekaboo.app（フルUX）
2. Claude.app（インストールされている場合）
3. OpenClaw.app（薄いブローカー）

`peekaboo bridge status --verbose`で、どのホストがアクティブでどのソケットパスが使用されているかを確認できます。以下でオーバーライドできます：

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## セキュリティとパーミッション

- ブリッジは**呼び出し元のコード署名**を検証します。TeamIDの許可リストが適用されます（Peekabooホスト TeamID + OpenClawアプリ TeamID）。
- リクエストは約10秒後にタイムアウトします。
- 必要なパーミッションがない場合、ブリッジはシステム設定を起動するのではなく、明確なエラーメッセージを返します。

## スナップショットの動作（オートメーション）

スナップショットはメモリに保存され、短い期間の後に自動的に期限切れになります。より長い保持が必要な場合は、クライアントから再キャプチャしてください。

## トラブルシューティング

- `peekaboo`が「bridge client is not authorized」と報告する場合は、クライアントが適切に署名されていることを確認するか、**デバッグ**モードでのみ`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`を設定してホストを実行してください。
- ホストが見つからない場合は、ホストアプリ（Peekaboo.appまたはOpenClaw.app）のいずれかを開き、パーミッションが付与されていることを確認してください。
