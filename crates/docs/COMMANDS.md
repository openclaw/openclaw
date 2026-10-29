# Commands

Every command this build implements, with flags and exit codes, followed by the
official commands it does **not** implement.

Run `openclaw help` for the same surface from the binary. The test
`openclaw-cli/tests/parity_table.rs` fails the build if this document's status
table and the binary disagree.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Operation failed (validation error, missing credential, unreachable Gateway, unknown subcommand for a command group) |
| `2` | Usage error (unknown flag, missing flag value) |

## Global

```bash
openclaw version            # also -V, --version
openclaw help               # also -h, --help
```

`help` lists implemented commands and then a `NOT IMPLEMENTED YET` block naming
the rest.

---

## `openclaw onboard`

Create config and a Gateway token.

```bash
openclaw onboard
openclaw onboard --install-daemon
openclaw onboard --no-install-daemon
```

| Flag | Effect |
|---|---|
| `--install-daemon` | Install the service after writing config; exits `1` if no service manager exists |
| `--no-install-daemon`, `--skip-daemon` | Skip service installation (default) |
| `--config <path>` | Accepted |

Writes `gateway.mode: "local"`, loopback listener, `requireAuth: true`, and a
generated `gateway.auth.token`. Idempotent. Unknown flags exit `2`.

---

## `openclaw gateway`

```bash
openclaw gateway                       # run in the foreground
openclaw gateway run [flags]
openclaw gateway status [flags]
openclaw gateway install [flags]
openclaw gateway uninstall
```

### `gateway run`

| Flag | Effect |
|---|---|
| `--config <path>` | Config file |
| `--listen <addr>` | Full listen address |
| `--port <n>` | Port only (keeps the configured host) |
| `--bind <host>` | Host only (keeps or overrides the port) |
| `--token <secret>` | Shared token; forces token auth |
| `--password <secret>` | Shared password; forces password auth |
| `--dashboard <addr>` | Control UI listen address |
| `--verbose`, `--dev` | Accepted |
| `--force`, `--reset` | **Not implemented**; exit non-zero |

Unknown flags exit non-zero. Refuses to start if auth is required but no secret
resolves, or if a non-loopback listener has `auth.mode: "none"`.

### `gateway status`

| Flag | Effect |
|---|---|
| `--json` | One JSON object: `ok`, `service.loaded`, `gateway.reachable/probed/unauthorized/port` |
| `--port <n>` | Retarget the probe |
| `--token <s>`, `--password <s>` | Credential for the probe |
| `--no-probe` | Skip the network check (`gateway.probed: false`) |
| `--deep`, `--require-rpc`, `--url`, `--timeout` | Accepted for compatibility |

Exit `0` only when reachable (or `--no-probe` with a loaded service); otherwise
`1`. Unknown flags exit `2`. Never prints the token.

### `gateway install`

| Flag | Effect |
|---|---|
| `--config <path>` | Config used to validate before installing |
| `--user` | User unit instead of a system unit |

Writes the service definition **and activates it**. Activation failure exits `1`.

- Linux: `openclaw-gateway.service` in `/etc/systemd/system` or
  `~/.config/systemd/user`
- macOS: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`

Unsupported hosts (e.g. Windows) exit `1` with "no supported service manager".

### `gateway uninstall`

Removes `openclaw-gateway.service`, its drop-in directory, the legacy
`clawdbot-gateway.service`, the user unit, and the launchd plist. Prints what it
removed; says so when nothing was installed.

### Not implemented

`gateway start`, `gateway stop`, `gateway restart` exit `1` with a message. They
do **not** fall through to `run` — an earlier build did, so `stop` started a
Gateway.

---

## `openclaw configure` (alias of `config`)

```bash
openclaw configure get gateway.listen
openclaw configure set logging.level debug
```

Identical to `openclaw config` — the same subcommands, flags, and exit codes.
The alias exists because the official product documents `configure` as the guided
entry point; here it is a straight pass-through, not an interactive wizard.

## `openclaw config`

```bash
openclaw config file
openclaw config get <path>
openclaw config set <path> <value>
openclaw config patch <json>
openclaw config unset <path>
openclaw config validate
openclaw config schema
```

| Behavior | Detail |
|---|---|
| Path syntax | Dotted, e.g. `gateway.listen`; empty segments rejected |
| Value typing | JSON when it parses: `true` → bool, `64` → number, else string |
| `--dry-run` | Print the planned result; write nothing |
| Read-only | `OPENCLAW_CONFIG_READONLY=1` or `OPENCLAW_NIX_MODE=1` blocks writers, allows reads |
| Atomicity | Temp file + rename |
| Blank value | Rejected |
| Unknown subcommand | Exit `1`, names the command |

`config validate` exits `1` and prints each problem. `config file` prints the
resolved path.

---

## `openclaw dashboard`

```bash
openclaw dashboard
openclaw dashboard --no-open
openclaw dashboard --json
```

| Flag | Effect |
|---|---|
| `--json` | One object; never opens a browser |
| `--no-open` | Print the URL only |
| `--yes` | Accepted |

Because this build cannot mint the documented one-time owner pairing handoff,
`--json` returns `ok: false` with `reason: "pairing_handoff_unavailable"` when the
UI is reachable, and `reason: "gateway_unreachable"` when it is not. Both exit
non-zero. The URL is still printed so you can authenticate with the Gateway token.

---

## `openclaw pairing`

```bash
openclaw pairing list [channel] [--channel <c>] [--account <id>] [--json]
openclaw pairing approve <channel> <code> [--account <id>] [--notify] [--json]
openclaw pairing approve --channel <c> <code>
openclaw pairing approve <code>            # only when exactly one channel is configured
```

| Flag | Effect |
|---|---|
| `--channel <c>` | Restrict to one channel |
| `--account <id>` | Restrict to one account; blank is rejected |
| `--notify` | Parsed; reports that delivery is not wired rather than claiming it sent |
| `--json` | `{ channel, requests }` |

Codes are 8 uppercase characters without `0 O 1 I`, expire after 1 hour, and are
capped at 3 pending per channel account. A repeat message from the same sender
does not re-send the code. Approving twice fails rather than reporting a fresh
approval.

---

## `openclaw uninstall`

```bash
openclaw uninstall --dry-run
openclaw uninstall --service --yes
openclaw uninstall --state --workspace --yes --non-interactive
openclaw uninstall --all --yes
```

| Flag | Effect |
|---|---|
| `--service` | Remove service definitions (official + legacy) |
| `--state` | Remove config and state; **preserves** workspaces |
| `--workspace` | Remove workspaces, including configured ones |
| `--app` | macOS app; "not applicable" elsewhere |
| `--all` | All four scopes |
| `--yes` | Skip confirmation |
| `--non-interactive` | No prompts; requires `--yes` (exit `1` otherwise) |
| `--dry-run` | Print the plan only |

No scope selected is an error, not a silent success. Failures are collected and
reported per scope.

---

## `openclaw doctor`

```bash
openclaw doctor [--config <path>]
```

Checks config validity, the SQLite database, skills, providers, and the Telegram
token. Exits `1` with a summary when any check reports a problem; `0` otherwise.
It does **not** repair anything (`--fix` is not implemented).

---

## `openclaw skills`

```bash
openclaw skills list
openclaw skills info <name>
```

Discovers `SKILL.md` from `skills/`, `custodian-skills/`, the installed share
directory, and `~/.openclaw/skills/`, plus embedded fallbacks.

## `openclaw memory`

```bash
openclaw memory list
openclaw memory add <key> <content>
```

Long-term memories in SQLite. There is no search, prune, or per-agent isolation.

## `openclaw cron`

```bash
openclaw cron list
```

Lists stored cron rows. **Nothing executes them** — there is no scheduler.

---

## Not implemented

These official commands do not exist. Running one prints
`unknown command: <name>` and exits `1`.

| Command | Note |
|---|---|
| `setup` | Onboarding alias / system chat |
| `update` | No channels, no self-update — see [`UPDATE.md`](UPDATE.md) |
| `backup`, `restore` | No archive or restore |
| `migrate` | No migration flow |
| `agents`, `agent` | No multi-agent roster, bindings, or one-shot turn |
| `channels` | No add/remove/status/login |
| `models` | No model catalog or selection |
| `plugins` | No plugin install/enable/disable |
| `sessions` | No session list/get/end CLI (the Gateway RPC exists) |
| `logs` | No log tail |
| `health`, `status` | No aggregate probes (use `gateway status`) |
| `devices`, `nodes`, `qr` | No device/node pairing or setup codes |
| `security`, `secrets`, `sandbox`, `approvals` | Absent |
| `mcp`, `acp`, `hooks`, `webhooks` | Absent |
| `message`, `infer` | Absent |
| `tui`, `completion` | Absent |
| `daemon` | Legacy alias for `gateway`; absent |

## Gateway RPC methods

Implemented over WebSocket (protocol 4): `connect`, `ping`, `health`,
`sessions.list`, `sessions.create`, `sessions.get`, `sessions.describe`,
`sessions.end`, `channels.list`, `channels.status`, `message.send` (returns
`UNAVAILABLE` — no channel transport is wired to Gateway delivery yet),
`config.get`.

Every method is authorized by operator scope before dispatch; unknown methods
default-deny with `INVALID_REQUEST` / `details.code: "METHOD_NOT_FOUND"`, and a
missing scope returns `FORBIDDEN` / `details.code: "MISSING_SCOPE"`.

The canonical table declares 486 methods, but only the ones above are dispatched.
The rest return `METHOD_NOT_FOUND`.
