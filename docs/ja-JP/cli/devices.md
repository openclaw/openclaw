---
summary: "`openclaw devices` のCLIリファレンス（デバイスペアリング + トークンのローテーション/失効）"
read_when:
  - デバイスペアリングリクエストを承認する場合
  - デバイストークンのローテーションまたは失効が必要な場合
title: "devices"
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

### `openclaw devices remove <deviceId>`

ペアリング済みデバイスのエントリを1つ削除します。

```
openclaw devices remove <deviceId>
openclaw devices remove <deviceId> --json
```

### `openclaw devices clear --yes [--pending]`

ペアリング済みデバイスを一括クリアします。

```
openclaw devices clear --yes
openclaw devices clear --yes --pending
openclaw devices clear --yes --pending --json
```

### `openclaw devices approve [requestId] [--latest]`

保留中のデバイスペアリングリクエストを承認します。`requestId` を省略すると、OpenClawは自動的に最新の保留中リクエストを承認します。

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

特定のロールのデバイストークンをローテーションします（オプションでスコープを更新）。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

特定のロールのデバイストークンを失効させます。

```
openclaw devices revoke --device <deviceId> --role node
```

## 共通オプション

- `--url <url>`: Gateway WebSocket URL（設定されている場合は `gateway.remote.url` がデフォルト）。
- `--token <token>`: Gatewayトークン（必要な場合）。
- `--password <password>`: Gatewayパスワード（パスワード認証）。
- `--timeout <ms>`: RPCタイムアウト。
- `--json`: JSON出力（スクリプティングに推奨）。

注意：`--url` を設定すると、CLIは設定や環境変数の資格情報にフォールバックしません。
`--token` または `--password` を明示的に渡してください。明示的な資格情報がない場合はエラーになります。

## 注意事項

- トークンのローテーションは新しいトークンを返します（機密情報）。シークレットとして扱ってください。
- これらのコマンドには `operator.pairing`（または `operator.admin`）スコープが必要です。
- `devices clear` は意図的に `--yes` で保護されています。
- ローカルループバックでペアリングスコープが利用できない場合（明示的な `--url` が渡されていない場合）、list/approveはローカルペアリングフォールバックを使用できます。
