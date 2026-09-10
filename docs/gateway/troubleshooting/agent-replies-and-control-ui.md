---
summary: "Storage errors, missing replies, and dashboard or Control UI connectivity and auth codes"
title: "Agent replies and Control UI"
sidebarTitle: "Agent replies and Control UI"
read_when:
  - An agent run fails with a storage error
  - Messages arrive but no reply comes back
  - The dashboard or Control UI will not connect and you need the auth detail codes
---

## Agent run failed with a storage error

An error naming the **Gateway state database** identifies a storage failure observed during the run. The chat banner, recorded assistant error, and `embedded_run_agent_end` log show the same diagnosis. Provider response bodies remain redacted.

| SQLite message                                     | Next step                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `database is locked` or `database table is locked` | Retry. If it repeats, check Gateway logs and concurrent storage maintenance.                                   |
| `database or disk is full`                         | Free disk space on the Gateway host, then retry.                                                               |
| `attempt to write a readonly database`             | Check the Gateway service user's storage permissions and filesystem mount mode.                                |
| `disk I/O error`                                   | Check storage health and filesystem access before retrying. This message alone does not prove disk exhaustion. |

A transcript writer ownership error means the run lost its session write claim. Retry in the current session and inspect Gateway logs if it recurs. Storage failures do not trigger provider credential rotation or automatic replay of the run.

Use `openclaw logs --follow` to correlate the run with storage activity. SQLite can contend between connections or worker threads in one Gateway process; seeing only one process with the database open does not rule out contention. See [database concurrency notes](/reference/database-schemas#integrity-checks). Avoid full database compaction while runs are active.

## No replies

If channels are up but nothing answers, check routing and policy before reconnecting anything.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw config get channels
openclaw logs --follow
```

Look for:

- Pairing pending for DM senders.
- Group mention gating (`requireMention`, `mentionPatterns`).
- Channel/group allowlist mismatches.

Common signatures:

- `drop guild message (mention required` → group message ignored until mention.
- `pairing request` → sender needs approval.
- `blocked` / `allowlist` → sender/channel was filtered by policy.

Related:

- [Channel troubleshooting](/channels/troubleshooting)
- [Groups](/channels/groups)
- [Pairing](/channels/pairing)

## Dashboard control UI connectivity

When the dashboard/control UI will not connect, validate URL, auth mode, and secure context assumptions.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Look for:

- Correct probe URL and dashboard URL.
- Auth mode/token mismatch between client and gateway.
- HTTP usage where device identity is required.

If a local browser cannot connect to `127.0.0.1:18789` after an update, first recover the local Gateway service and confirm it is serving the dashboard:

```bash
openclaw gateway restart
lsof -i :18789
curl http://127.0.0.1:18789
```

If `curl` returns OpenClaw HTML, the Gateway is working and the remaining issue is likely browser cache, an old deep link, or stale tab state. Open `http://127.0.0.1:18789` directly and navigate from the dashboard. If restart does not leave the service running, run `openclaw gateway start` and recheck `openclaw gateway status`.

<AccordionGroup>
  <Accordion title="Connect / auth signatures">
    - `device identity required` → non-secure context or missing device auth.
    - `origin not allowed` → browser `Origin` is not in `gateway.controlUi.allowedOrigins` (or you are connecting from a non-loopback browser origin without an explicit allowlist).
    - `device nonce required` / `device nonce mismatch` → client is not completing the challenge-based device auth flow (`connect.challenge` + `device.nonce`).
    - `device signature invalid` / `device signature expired` → client signed the wrong payload (or stale timestamp) for the current handshake.
    - `AUTH_TOKEN_MISMATCH` with `canRetryWithDeviceToken=true` → client can do one trusted retry with cached device token.
    - That cached-token retry reuses the cached scope set stored with the paired device token. Explicit `deviceToken` / explicit `scopes` callers keep their requested scope set instead.
    - `AUTH_SCOPE_MISMATCH` → the device token was recognized, but its approved scopes do not cover this connect request; re-pair or approve the requested scope contract instead of rotating a shared gateway token.
    - Outside that retry path, connect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
    - On the async Tailscale Serve Control UI path, failed attempts for the same `{scope, ip}` are serialized before the limiter records the failure. Two bad concurrent retries from the same client can therefore surface `retry later` on the second attempt instead of two plain mismatches.
    - `too many failed authentication attempts (retry later)` from a browser-origin loopback client → repeated failures from that same normalized `Origin` are locked out temporarily; another localhost origin uses a separate bucket.
    - Repeated `unauthorized` after that retry → shared token/device token drift; refresh token config and re-approve/rotate device token if needed.
    - `gateway connect failed:` → wrong host/port/url target.

  </Accordion>
</AccordionGroup>

### Auth detail codes quick map

Use `error.details.code` from the failed `connect` response to pick the next action:

| Detail code                  | Meaning                                                                                                                                                                                      | Recommended action                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_MISSING`         | Client did not send a required shared token.                                                                                                                                                 | On the Gateway host, run `openclaw gateway auth-token --show` in an interactive terminal, paste the output into the client, and retry.                                                                                                                                                   |
| `AUTH_TOKEN_MISMATCH`        | Shared token did not match gateway auth token.                                                                                                                                               | If `canRetryWithDeviceToken=true`, allow one trusted retry. Cached-token retries reuse stored approved scopes; explicit `deviceToken` / `scopes` callers keep requested scopes. If still failing, run the [token drift recovery checklist](/cli/devices#token-drift-recovery-checklist). |
| `AUTH_DEVICE_TOKEN_MISMATCH` | Cached per-device token is stale or revoked.                                                                                                                                                 | Rotate/re-approve device token using [devices CLI](/cli/devices), then reconnect.                                                                                                                                                                                                        |
| `AUTH_SCOPE_MISMATCH`        | Device token is valid, but its approved role/scopes do not cover this connect request.                                                                                                       | Re-pair the device or approve the requested scope contract; do not treat this as shared-token drift.                                                                                                                                                                                     |
| `PAIRING_REQUIRED`           | Device identity needs approval. Check `error.details.reason` for `not-paired`, `scope-upgrade`, `role-upgrade`, or `metadata-upgrade`, and use `requestId` / `remediationHint` when present. | Approve pending request: `openclaw devices list` then `openclaw devices approve <requestId>`. Scope/role upgrades use the same flow after you review the requested access.                                                                                                               |

<Note>
Direct loopback backend RPCs authenticated with the shared gateway token/password should not depend on the CLI's paired-device scope baseline. If subagents or other internal calls still fail with `scope-upgrade`, verify the caller is using `client.id: "gateway-client"` and `client.mode: "backend"` and is not forcing an explicit `deviceIdentity` or device token.
</Note>

Device auth v2 migration check:

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

If logs show nonce/signature errors, update the connecting client and verify it:

<Steps>
  <Step title="Wait for connect.challenge">
    Client waits for the gateway-issued `connect.challenge`.
  </Step>
  <Step title="Sign the payload">
    Client signs the challenge-bound payload.
  </Step>
  <Step title="Send the device nonce">
    Client sends `connect.params.device.nonce` with the same challenge nonce.
  </Step>
</Steps>

If `openclaw devices rotate` / `revoke` / `remove` is denied unexpectedly:

- Paired-device token sessions can manage only **their own** device unless the caller also has `operator.admin`.
- `openclaw devices rotate --scope ...` can only request operator scopes that the caller session already holds.

Related:

- [Configuration](/gateway/configuration) (gateway auth modes)
- [Control UI](/web/control-ui)
- [Devices](/cli/devices)
- [Remote access](/gateway/remote)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)
