---
summary: "「openclaw devices」の CLI リファレンス（デバイスのペアリングとトークンのローテーション／失効）"
read_when:
  - デバイスのペアリング要求を承認する場合
  - デバイストークンをローテーションまたは失効させる必要がある場合
title: "デバイス"
x-i18n:
  source_path: cli/devices.md
  source_hash: ac7d130ecdc5d429
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:04Z
---

# `openclaw devices`

デバイスのペアリング要求と、デバイススコープのトークンを管理します。

## Commands

### `openclaw devices list`

保留中のペアリング要求と、ペアリング済みのデバイスを一覧表示します。

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

保留中のデバイスペアリング要求を承認します。

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

保留中のデバイスペアリング要求を拒否します。

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

特定のロールに対するデバイストークンをローテーションします（必要に応じてスコープを更新）。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

特定のロールに対するデバイストークンを失効させます。

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket URL（設定されている場合、既定値は `gateway.remote.url`）。
- `--token <token>`: Gateway トークン（必要な場合）。
- `--password <password>`: Gateway パスワード（パスワード認証）。
- `--timeout <ms>`: RPC タイムアウト。
- `--json`: JSON 出力（スクリプト向けに推奨）。

注記: `--url` を設定すると、CLI は設定や環境変数の資格情報にフォールバックしません。
`--token` または `--password` を明示的に指定してください。明示的な資格情報が欠落している場合はエラーになります。

## Notes

- トークンのローテーションでは新しいトークン（機密情報）が返されます。シークレットとして取り扱ってください。
- これらのコマンドには `operator.pairing`（または `operator.admin`）スコープが必要です。
