---
summary: "macOS UI 自動化向けの PeekabooBridge 統合"
read_when:
  - OpenClaw.app で PeekabooBridge をホストする場合
  - Swift Package Manager を介して Peekaboo を統合する場合
  - PeekabooBridge のプロトコルやパスを変更する場合
title: "Peekaboo Bridge"
---

# Peekaboo Bridge（macOS UI 自動化）

OpenClaw は、**PeekabooBridge** をローカルで権限を認識する UI 自動化ブローカーとしてホストできます。
これにより、`peekaboo` CLI が、macOS アプリの TCC 権限を再利用しながら UI 自動化を実行できます。 これにより、
macOSアプリのTCCパーミッションを再利用しながら、`peekaboo` CLI がUIオートメーションを駆動できます。

## これは何か（そして何ではないか）

- **ホスト**: OpenClaw.app は PeekabooBridge のホストとして動作できます。
- **クライアント**: `peekaboo` CLI を使用します（別途 `openclaw ui ...` の UI はありません）。
- **UI**: 視覚的なオーバーレイは Peekaboo.app に残り、OpenClaw は薄いブローカーホストです。

## ブリッジを有効にする

macOS アプリで次を実行します。

- 設定 → **Enable Peekaboo Bridge**

有効にすると、OpenClaw はローカルの UNIX ソケットサーバーを起動します。無効の場合、ホストは停止し、`peekaboo` は他の利用可能なホストにフォールバックします。 無効にすると、ホスト
が停止し、`peekaboo` は他の利用可能なホストに戻ります。

## クライアントの検出順

Peekaboo クライアントは通常、次の順序でホストを試行します。

1. Peekaboo.app（フル UX）
2. Claude.app（インストールされている場合）
3. OpenClaw.app（薄いブローカー）

`peekaboo bridge status --verbose` を使用すると、どのホストがアクティブか、どのソケットパスが使用されているかを確認できます。次で上書きすることもできます。 上書きすることができます:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## セキュリティと権限

- ブリッジは **呼び出し元のコード署名** を検証します。TeamID の許可リストが適用されます（Peekaboo ホストの TeamID + OpenClaw アプリの TeamID）。
- リクエストは約 10 秒でタイムアウトします。
- 必要な権限が不足している場合、ブリッジはシステム設定を起動するのではなく、明確なエラーメッセージを返します。

## スナップショットの挙動（自動化）

スナップショットはメモリに保存され、短いウィンドウの後に自動的に期限切れになります。
長時間のリテンションが必要な場合は、クライアントから再キャプチャします。

## トラブルシューティング

- `peekaboo` が「bridge client is not authorized」と報告する場合、クライアントが適切に署名されていることを確認するか、**デバッグ** モードのみで `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` を指定してホストを実行してください。
- ホストが見つからない場合は、ホストアプリ（Peekaboo.app または OpenClaw.app）のいずれかを開き、権限が付与されていることを確認してください。
