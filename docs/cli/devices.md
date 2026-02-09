---
summary: "CLI reference for `EasyHub devices` (device pairing + token rotation/revocation)"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "devices"
---

# `EasyHub devices`

Manage device pairing requests and device-scoped tokens.

## Commands

### `EasyHub devices list`

List pending pairing requests and paired devices.

```
EasyHub devices list
EasyHub devices list --json
```

### `EasyHub devices approve <requestId>`

Approve a pending device pairing request.

```
EasyHub devices approve <requestId>
```

### `EasyHub devices reject <requestId>`

Reject a pending device pairing request.

```
EasyHub devices reject <requestId>
```

### `EasyHub devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a specific role (optionally updating scopes).

```
EasyHub devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `EasyHub devices revoke --device <id> --role <role>`

Revoke a device token for a specific role.

```
EasyHub devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` when configured).
- `--token <token>`: Gateway token (if required).
- `--password <password>`: Gateway password (password auth).
- `--timeout <ms>`: RPC timeout.
- `--json`: JSON output (recommended for scripting).

Note: when you set `--url`, the CLI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

## Notes

- Token rotation returns a new token (sensitive). Treat it like a secret.
- These commands require `operator.pairing` (or `operator.admin`) scope.
