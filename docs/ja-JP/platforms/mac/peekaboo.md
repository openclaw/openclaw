---
read_when:
    - OpenClaw.app での PeekabooBridge のホスティング時
    - Swift Package Manager 経由での Peekaboo 統合時
    - PeekabooBridge のプロトコル/パス変更時
summary: macOS UI オートメーション向け PeekabooBridge 統合
title: Peekaboo Bridge
x-i18n:
    generated_at: "2026-04-02T07:48:01Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 30961eb502eecd23c017b58b834bd8cb00cab8b17302617d541afdace3ad8dba
    source_path: platforms/mac/peekaboo.md
    workflow: 15
---

# Peekaboo Bridge（macOS UI オートメーション）

OpenClaw はローカルの権限対応 UI オートメーションブローカーとして **PeekabooBridge** を
ホストできます。これにより、`peekaboo` CLI が macOS アプリの TCC 権限を再利用しながら
UI オートメーションを駆動できます。

## これは何か（何でないか）

- **ホスト**: OpenClaw.app は PeekabooBridge ホストとして動作できます。
- **クライアント**: `peekaboo` CLI を使用します（別途 `openclaw ui ...` のインターフェースはありません）。
- **UI**: ビジュアルオーバーレイは Peekaboo.app に留まります。OpenClaw は薄いブローカーホストです。

## ブリッジの有効化

macOS アプリで:

- 設定 → **Enable Peekaboo Bridge**

有効にすると、OpenClaw はローカル UNIX ソケットサーバーを起動します。無効にすると、ホストは
停止され、`peekaboo` は他の利用可能なホストにフォールバックします。

## クライアントのディスカバリー順序

Peekaboo クライアントは通常、以下の順序でホストを試行します:

1. Peekaboo.app（フル UX）
2. Claude.app（インストールされている場合）
3. OpenClaw.app（薄いブローカー）

`peekaboo bridge status --verbose` を使用して、アクティブなホストと使用中のソケットパスを
確認できます。以下でオーバーライドできます:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## セキュリティと権限

- ブリッジは**呼び出し元のコード署名**を検証します。TeamID の許可リストが
  適用されます（Peekaboo ホスト TeamID + OpenClaw アプリ TeamID）。
- リクエストは約10秒後にタイムアウトします。
- 必要な権限が不足している場合、ブリッジはシステム設定を起動する代わりに
  明確なエラーメッセージを返します。

## スナップショットの動作（オートメーション）

スナップショットはメモリに保存され、短い期間の後に自動的に期限切れになります。
より長い保持が必要な場合は、クライアントから再キャプチャしてください。

## トラブルシューティング

- `peekaboo` が「bridge client is not authorized」と報告する場合、クライアントが
  適切に署名されていることを確認するか、**デバッグ**モードのみで
  `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` を設定してホストを実行してください。
- ホストが見つからない場合、ホストアプリ（Peekaboo.app または OpenClaw.app）のいずれかを
  開き、権限が付与されていることを確認してください。
