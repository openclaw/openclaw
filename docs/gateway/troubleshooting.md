---
summary: "Deep troubleshooting runbook for gateway, channels, automation, nodes, and browser"
read_when:
  - The troubleshooting hub pointed you here for deeper diagnosis
  - You need stable symptom based runbook sections with exact commands
title: "Troubleshooting"
---

# Gateway troubleshooting

This page is the deep runbook.
Start at [/help/troubleshooting](/help/troubleshooting) if you want the fast triage flow first.

## Command ladder

Run these first, in this order:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Expected healthy signals:

- `openclaw gateway status` shows `Runtime: running` and `RPC probe: ok`.
- `openclaw doctor` reports no blocking config/service issues.
- `openclaw channels status --probe` shows connected/ready channels.

## Anthropic 429 extra usage required for long context

Use this when logs/errors include:
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`.

```bash
openclaw logs --follow
openclaw models status
openclaw config get agents.defaults.models
```

Look for:

- Selected Anthropic Opus/Sonnet model has `params.context1m: true`.
- Current Anthropic credential is not eligible for long-context usage.
- Requests fail only on long sessions/model runs that need the 1M beta path.

Fix options:

1. Disable `context1m` for that model to fall back to the normal context window.
2. Use an Anthropic API key with billing, or enable Anthropic Extra Usage on the subscription account.
3. Configure fallback models so runs continue when Anthropic long-context requests are rejected.

Related:

- [/providers/anthropic](/providers/anthropic)
- [/reference/token-use](/reference/token-use)
- [/help/faq#why-am-i-seeing-http-429-ratelimiterror-from-anthropic](/help/faq#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)

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

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard control ui connectivity

When dashboard/control UI will not connect, validate URL, auth mode, and secure context assumptions.

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

Common signatures:

- `device identity required` → non-secure context or missing device auth.
- `origin not allowed` → browser `Origin` is not in `gateway.controlUi.allowedOrigins`
  (or you are connecting from a non-loopback browser origin without an explicit
  allowlist).
- `device nonce required` / `device nonce mismatch` → client is not completing the
  challenge-based device auth flow (`connect.challenge` + `device.nonce`).
- `device signature invalid` / `device signature expired` → client signed the wrong
  payload (or stale timestamp) for the current handshake.
- `AUTH_TOKEN_MISMATCH` with `canRetryWithDeviceToken=true` → client can do one trusted retry with cached device token.
- That cached-token retry reuses the cached scope set stored with the paired
  device token. Explicit `deviceToken` / explicit `scopes` callers keep their
  requested scope set instead.
- Outside that retry path, connect auth precedence is explicit shared
  token/password first, then explicit `deviceToken`, then stored device token,
  then bootstrap token.
- On the async Tailscale Serve Control UI path, failed attempts for the same
  `{scope, ip}` are serialized before the limiter records the failure. Two bad
  concurrent retries from the same client can therefore surface `retry later`
  on the second attempt instead of two plain mismatches.
- `too many failed authentication attempts (retry later)` from a browser-origin
  loopback client → repeated failures from that same normalized `Origin` are
  locked out temporarily; another localhost origin uses a separate bucket.
- repeated `unauthorized` after that retry → shared token/device token drift; refresh token config and re-approve/rotate device token if needed.
- `gateway connect failed:` → wrong host/port/url target.

### Auth detail codes quick map

Use `error.details.code` from the failed `connect` response to pick the next action:

| Detail code                  | Meaning                                                  | Recommended action                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_MISSING`         | Client did not send a required shared token.             | Paste/set token in the client and retry. For dashboard paths: `openclaw config get gateway.auth.token` then paste into Control UI settings.                                                                                                                                              |
| `AUTH_TOKEN_MISMATCH`        | Shared token did not match gateway auth token.           | If `canRetryWithDeviceToken=true`, allow one trusted retry. Cached-token retries reuse stored approved scopes; explicit `deviceToken` / `scopes` callers keep requested scopes. If still failing, run the [token drift recovery checklist](/cli/devices#token-drift-recovery-checklist). |
| `AUTH_DEVICE_TOKEN_MISMATCH` | Cached per-device token is stale or revoked.             | Rotate/re-approve device token using [devices CLI](/cli/devices), then reconnect.                                                                                                                                                                                                        |
| `PAIRING_REQUIRED`           | Device identity is known but not approved for this role. | Approve pending request: `openclaw devices list` then `openclaw devices approve <requestId>`.                                                                                                                                                                                            |

Device auth v2 migration check:

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

If logs show nonce/signature errors, update the connecting client and verify it:

1. waits for `connect.challenge`
2. signs the challenge-bound payload
3. sends `connect.params.device.nonce` with the same challenge nonce

Related:

- [/web/control-ui](/web/control-ui)
- [/gateway/configuration](/gateway/configuration) (gateway auth modes)
- [/gateway/trusted-proxy-auth](/gateway/trusted-proxy-auth)
- [/gateway/remote](/gateway/remote)
- [/cli/devices](/cli/devices)

## Gateway service not running

Use this when service is installed but process does not stay up.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Look for:

- `Runtime: stopped` with exit hints.
- Service config mismatch (`Config (cli)` vs `Config (service)`).
- Port/listener conflicts.

Common signatures:

- `Gateway start blocked: set gateway.mode=local` or `existing config is missing gateway.mode` → local gateway mode is not enabled, or the config file was clobbered and lost `gateway.mode`. Fix: set `gateway.mode="local"` in your config, or re-run `openclaw onboard --mode local` / `openclaw setup` to restamp the expected local-mode config. If you are running OpenClaw via Podman, the default config path is `~/.openclaw/openclaw.json`.
- `refusing to bind gateway ... without auth` → non-loopback bind without a valid gateway auth path (token/password, or trusted-proxy where configured).
- `another gateway instance is already listening` / `EADDRINUSE` → port conflict.

Related:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Channel connected messages not flowing

If channel state is connected but message flow is dead, focus on policy, permissions, and channel specific delivery rules.

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Look for:

- DM policy (`pairing`, `allowlist`, `open`, `disabled`).
- Group allowlist and mention requirements.
- Missing channel API permissions/scopes.

Common signatures:

- `mention required` → message ignored by group mention policy.
- `pairing` / pending approval traces → sender is not approved.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → channel auth/permissions issue.

Related:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron and heartbeat delivery

If cron or heartbeat did not run or did not deliver, verify scheduler state first, then delivery target.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Look for:

- Cron enabled and next wake present.
- Job run history status (`ok`, `skipped`, `error`).
- Heartbeat skip reasons (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Common signatures:

- `cron: scheduler disabled; jobs will not run automatically` → cron disabled.
- `cron: timer tick failed` → scheduler tick failed; check file/log/runtime errors.
- `heartbeat skipped` with `reason=quiet-hours` → outside active hours window.
- `heartbeat: unknown accountId` → invalid account id for heartbeat delivery target.
- `heartbeat skipped` with `reason=dm-blocked` → heartbeat target resolved to a DM-style destination while `agents.defaults.heartbeat.directPolicy` (or per-agent override) is set to `block`.

Related:

- [/automation/cron-jobs#troubleshooting](/automation/cron-jobs#troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Node paired tool fails

If a node is paired but tools fail, isolate foreground, permission, and approval state.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Look for:

- Node online with expected capabilities.
- OS permission grants for camera/mic/location/screen.
- Exec approvals and allowlist state.

Common signatures:

- `NODE_BACKGROUND_UNAVAILABLE` → node app must be in foreground.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → missing OS permission.
- `SYSTEM_RUN_DENIED: approval required` → exec approval pending.
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist.

Related:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Browser tool fails

Use this when browser tool actions fail even though the gateway itself is healthy.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Look for:

- Whether `plugins.allow` is set and includes `browser`.
- Valid browser executable path.
- CDP profile reachability.
- Local Chrome availability for `existing-session` / `user` profiles.

Common signatures:

- `unknown command "browser"` or `unknown command 'browser'` → the bundled browser plugin is excluded by `plugins.allow`.
- browser tool missing / unavailable while `browser.enabled=true` → `plugins.allow` excludes `browser`, so the plugin never loaded.
- `Failed to start Chrome CDP on port` → browser process failed to launch.
- `browser.executablePath not found` → configured path is invalid.
- `browser.cdpUrl must be http(s) or ws(s)` → the configured CDP URL uses an unsupported scheme such as `file:` or `ftp:`.
- `browser.cdpUrl has invalid port` → the configured CDP URL has a bad or out-of-range port.
- `No Chrome tabs found for profile="user"` → the Chrome MCP attach profile has no open local Chrome tabs.
- `Remote CDP for profile "<name>" is not reachable` → the configured remote CDP endpoint is not reachable from the gateway host.
- `Browser attachOnly is enabled ... not reachable` or `Browser attachOnly is enabled and CDP websocket ... is not reachable` → attach-only profile has no reachable target, or the HTTP endpoint answered but the CDP WebSocket still could not be opened.
- `Playwright is not available in this gateway build; '<feature>' is unsupported.` → the current gateway install lacks the full Playwright package; ARIA snapshots and basic page screenshots can still work, but navigation, AI snapshots, CSS-selector element screenshots, and PDF export stay unavailable.
- `fullPage is not supported for element screenshots` → screenshot request mixed `--full-page` with `--ref` or `--element`.
- `element screenshots are not supported for existing-session profiles; use ref from snapshot.` → Chrome MCP / `existing-session` screenshot calls must use page capture or a snapshot `--ref`, not CSS `--element`.
- stale viewport / dark-mode / locale / offline overrides on attach-only or remote CDP profiles → run `openclaw browser stop --browser-profile <name>` to close the active control session and release Playwright/CDP emulation state without restarting the whole gateway.

Related:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/browser](/tools/browser)

## If you upgraded and something suddenly broke

Most post-upgrade breakage is config drift or stricter defaults now being enforced.

### 1) Auth and URL override behavior changed

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

What to check:

- If `gateway.mode=remote`, CLI calls may be targeting remote while your local service is fine.
- Explicit `--url` calls do not fall back to stored credentials.

Common signatures:

- `gateway connect failed:` → wrong URL target.
- `unauthorized` → endpoint reachable but wrong auth.

### 2) Bind and auth guardrails are stricter

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

What to check:

- Non-loopback binds (`lan`, `tailnet`, `custom`) need auth configured.
- Old keys like `gateway.token` do not replace `gateway.auth.token`.

Common signatures:

- `refusing to bind gateway ... without auth` → bind+auth mismatch.
- `RPC probe: failed` while runtime is running → gateway alive but inaccessible with current auth/url.

### 3) Pairing and device identity state changed

```bash
openclaw devices list
openclaw pairing list --channel <channel> [--account <id>]
openclaw logs --follow
openclaw doctor
```

What to check:

- Pending device approvals for dashboard/nodes.
- Pending DM pairing approvals after policy or identity changes.

Common signatures:

- `device identity required` → device auth not satisfied.
- `pairing required` → sender/device must be approved.

If the service config and runtime still disagree after checks, reinstall service metadata from the same profile/state directory:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Related:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
