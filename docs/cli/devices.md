---
summary: "CLI reference for `mullusi devices` (device pairing + token rotation/revocation)"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "devices"
---

# `mullusi devices`

Manage device pairing requests and device-scoped tokens.

## Commands

### `mullusi devices list`

List pending pairing requests and paired devices.

```
mullusi devices list
mullusi devices list --json
```

Pending request output includes the requested role and scopes so approvals can
be reviewed before you approve.

### `mullusi devices remove <deviceId>`

Remove one paired device entry.

When you are authenticated with a paired device token, non-admin callers can
remove only **their own** device entry. Removing some other device requires
`operator.admin`.

```
mullusi devices remove <deviceId>
mullusi devices remove <deviceId> --json
```

### `mullusi devices clear --yes [--pending]`

Clear paired devices in bulk.

```
mullusi devices clear --yes
mullusi devices clear --yes --pending
mullusi devices clear --yes --pending --json
```

### `mullusi devices approve [requestId] [--latest]`

Approve a pending device pairing request. If `requestId` is omitted, Mullusi
automatically approves the most recent pending request.

Note: if a device retries pairing with changed auth details (role/scopes/public
key), Mullusi supersedes the previous pending entry and issues a new
`requestId`. Run `mullusi devices list` right before approval to use the
current ID.

```
mullusi devices approve
mullusi devices approve <requestId>
mullusi devices approve --latest
```

### `mullusi devices reject <requestId>`

Reject a pending device pairing request.

```
mullusi devices reject <requestId>
```

### `mullusi devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a specific role (optionally updating scopes).
The target role must already exist in that device's approved pairing contract;
rotation cannot mint a new unapproved role.
If you omit `--scope`, later reconnects with the stored rotated token reuse that
token's cached approved scopes. If you pass explicit `--scope` values, those
become the stored scope set for future cached-token reconnects.
Non-admin paired-device callers can rotate only their **own** device token.
Also, any explicit `--scope` values must stay within the caller session's own
operator scopes; rotation cannot mint a broader operator token than the caller
already has.

```
mullusi devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

Returns the new token payload as JSON.

### `mullusi devices revoke --device <id> --role <role>`

Revoke a device token for a specific role.

Non-admin paired-device callers can revoke only their **own** device token.
Revoking some other device's token requires `operator.admin`.

```
mullusi devices revoke --device <deviceId> --role node
```

Returns the revoke result as JSON.

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
- Token rotation stays inside the approved pairing role set and approved scope
  baseline for that device. A stray cached token entry does not grant a new
  rotate target.
- For paired-device token sessions, cross-device management is admin-only:
  `remove`, `rotate`, and `revoke` are self-only unless the caller has
  `operator.admin`.
- `devices clear` is intentionally gated by `--yes`.
- If pairing scope is unavailable on local loopback (and no explicit `--url` is passed), list/approve can use a local pairing fallback.
- `devices approve` picks the newest pending request automatically when you omit `requestId` or pass `--latest`.

## Token drift recovery checklist

Use this when Control UI or other clients keep failing with `AUTH_TOKEN_MISMATCH` or `AUTH_DEVICE_TOKEN_MISMATCH`.

1. Confirm current gateway token source:

```bash
mullusi config get gateway.auth.token
```

2. List paired devices and identify the affected device id:

```bash
mullusi devices list
```

3. Rotate operator token for the affected device:

```bash
mullusi devices rotate --device <deviceId> --role operator
```

4. If rotation is not enough, remove stale pairing and approve again:

```bash
mullusi devices remove <deviceId>
mullusi devices list
mullusi devices approve <requestId>
```

5. Retry client connection with the current shared token/password.

Notes:

- Normal reconnect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
- Trusted `AUTH_TOKEN_MISMATCH` recovery can temporarily send both the shared token and the stored device token together for the one bounded retry.

Related:

- [Dashboard auth troubleshooting](/web/dashboard#if-you-see-unauthorized-1008)
- [Gateway troubleshooting](/gateway/troubleshooting#dashboard-control-ui-connectivity)
