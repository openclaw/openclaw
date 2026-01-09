---
summary: "Model authentication: OAuth, API keys, and Claude Code token reuse"
read_when:
  - Debugging model auth or OAuth expiry
  - Documenting authentication or credential storage
---
# Authentication

Clawdbot supports OAuth and API keys for model providers. For Anthropic
subscription accounts, the most stable path is to **reuse Claude Code OAuth
credentials**, including the 1‑year token created by `claude setup-token`.

See [/concepts/oauth](/concepts/oauth) for the full OAuth flow and storage
layout.

## Recommended: long‑lived Claude Code token

Run this on the **gateway host** (the machine running the Gateway):

```bash
claude setup-token
```

This issues a long‑lived **OAuth token** (not an API key) and stores it for
Claude Code. Then sync and verify:

```bash
clawdbot models status
clawdbot doctor
```

Automation-friendly check (exit `1` when expired/missing, `2` when expiring):

```bash
clawdbot models status --check
```

Optional ops scripts (systemd/Termux) are documented here:
[/automation/auth-monitoring](/automation/auth-monitoring)

`clawdbot models status` loads Claude Code credentials into Clawdbot’s
`auth-profiles.json` and shows expiry (warns within 24h by default).
`clawdbot doctor` also performs the sync when it runs.

> `claude setup-token` requires an interactive TTY.

## Checking model auth status

```bash
clawdbot models status
clawdbot doctor
```

## How sync works

1. **Claude Code** stores credentials in `~/.claude/.credentials.json` (or
   Keychain on macOS).
2. **Clawdbot** syncs those into
   `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json` when the auth store is
   loaded.
3. OAuth refresh happens automatically on use if a token is expired.

## Troubleshooting

### “No credentials found”

If the Anthropic OAuth profile is missing, run `claude setup-token` on the
**gateway host**, then re-check:

```bash
clawdbot models status
```

### Token expiring/expired

Run `clawdbot models status` to confirm which profile is expiring. If the profile
is `anthropic:claude-cli`, rerun `claude setup-token`.

## Requirements

- Claude Max or Pro subscription (for `claude setup-token`)
- Claude Code CLI installed (`claude` command available)
