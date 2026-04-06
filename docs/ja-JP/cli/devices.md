---
read_when:
    - デバイスペアリングリクエストを承認する場合
    - デバイストークンのローテーションまたは失効が必要な場合
summary: '`openclaw devices`（デバイスペアリング + トークンのローテーション/失効）のCLIリファレンス'
title: devices
x-i18n:
    generated_at: "2026-04-02T07:33:35Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: e6bea5a3968b459e86f5ecc33cfa672192c068c129c70ce9bdef3ecc13350d04
    source_path: cli/devices.md
    workflow: 15
---

# `openclaw devices`

デバイスペアリングリクエストとデバイススコープのトークンを管理します。

## コマンド

### `openclaw devices list`

保留中のペアリングリクエストとペアリング済みデバイスを一覧表示します。

```
openclaw devices list
openclaw devices list --json
```

保留中のリクエスト出力には、リクエストされたロールとスコープが含まれるため、承認前にレビューできます。

### `openclaw devices remove <deviceId>`

ペアリング済みデバイスのエントリを1つ削除します。

```
openclaw devices remove <deviceId>
openclaw devices remove <deviceId> --json
```

### `openclaw devices clear --yes [--pending]`

ペアリング済みデバイスを一括でクリアします。

```
openclaw devices clear --yes
openclaw devices clear --yes --pending
openclaw devices clear --yes --pending --json
```

### `openclaw devices approve [requestId] [--latest]`

保留中のデバイスペアリングリクエストを承認します。`requestId` を省略した場合、OpenClawは最新の保留中リクエストを自動的に承認します。

注意: デバイスが認証の詳細（ロール/スコープ/公開鍵）を変更してペアリングを再試行した場合、OpenClawは以前の保留中エントリを置き換え、新しい `requestId` を発行します。承認直前に `openclaw devices list` を実行して現在のIDを使用してください。

```
openclaw devices approve
openclaw devices approve <requestId>
openclaw devices approve --latest
```

### `openclaw devices reject <requestId>`

保留中のデバイスペアリングリクエストを拒否します。

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

特定のロールのデバイストークンをローテーションします（オプションでスコープも更新可能）。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

特定のロールのデバイストークンを失効させます。

```
openclaw devices revoke --device <deviceId> --role node
```

## 共通オプション

- `--url <url>`: Gateway ゲートウェイのWebSocket URL（設定時は `gateway.remote.url` がデフォルト）。
- `--token <token>`: Gateway ゲートウェイのトークン（必要な場合）。
- `--password <password>`: Gateway ゲートウェイのパスワード（パスワード認証）。
- `--timeout <ms>`: RPCタイムアウト。
- `--json`: JSON出力（スクリプティングに推奨）。

注意: `--url` を設定した場合、CLIは設定や環境変数の認証情報にフォールバックしません。
`--token` または `--password` を明示的に渡してください。明示的な認証情報がない場合はエラーになります。

## 注意事項

- トークンのローテーションは新しいトークン（機密情報）を返します。シークレットとして扱ってください。
- これらのコマンドには `operator.pairing`（または `operator.admin`）スコープが必要です。
- `devices clear` は意図的に `--yes` で制限されています。
- local loopbackでペアリングスコープが利用できない場合（かつ明示的な `--url` が渡されていない場合）、list/approveはローカルペアリングフォールバックを使用できます。

## トークンのドリフト回復チェックリスト

Control UIやその他のクライアントが `AUTH_TOKEN_MISMATCH` または `AUTH_DEVICE_TOKEN_MISMATCH` で失敗し続ける場合に使用してください。

1. 現在のGateway ゲートウェイのトークンソースを確認:

```bash
openclaw config get gateway.auth.token
```

2. ペアリング済みデバイスを一覧表示し、影響を受けるデバイスIDを特定:

```bash
openclaw devices list
```

3. 影響を受けるデバイスのオペレータートークンをローテーション:

```bash
openclaw devices rotate --device <deviceId> --role operator
```

4. ローテーションで不十分な場合、古いペアリングを削除して再度承認:

```bash
openclaw devices remove <deviceId>
openclaw devices list
openclaw devices approve <requestId>
```

5. 現在の共有トークン/パスワードでクライアント接続を再試行。

関連:

- [ダッシュボード認証のトラブルシューティング](/web/dashboard#if-you-see-unauthorized-1008)
- [Gateway ゲートウェイのトラブルシューティング](/gateway/troubleshooting#dashboard-control-ui-connectivity)
