---
summary: "「openclaw devices」的 CLI 參考（裝置配對＋權杖輪替／撤銷）"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "裝置"
---

# `openclaw devices`

Manage device pairing requests and device-scoped tokens.

## Commands

### `openclaw devices list`

List pending pairing requests and paired devices.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Approve a pending device pairing request.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Reject a pending device pairing request.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a specific role (optionally updating scopes).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Revoke a device token for a specific role.

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`：Gateway 閘道器 WebSocket URL（已設定時預設為 `gateway.remote.url`）。
- `--token <token>`：Gateway 閘道器權杖（若需要）。
- `--password <password>`：Gateway 閘道器密碼（密碼驗證）。
- `--timeout <ms>`：RPC 逾時。
- `--json`：JSON 輸出（建議用於指令碼）。

注意：當你設定 `--url` 時，CLI 不會回退使用設定或環境中的認證。
請明確傳遞 `--token` 或 `--password`。缺少明確的認證將視為錯誤。
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

## Notes

- Token rotation returns a new token (sensitive). Treat it like a secret.
- 這些指令需要 `operator.pairing`（或 `operator.admin`）範圍。
