---
summary: "CLI reference for `smart-agent-neo doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "doctor"
---

# `smart-agent-neo doctor`

Health checks + quick fixes for the gateway and channels.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Examples

```bash
smart-agent-neo doctor
smart-agent-neo doctor --repair
smart-agent-neo doctor --deep
```

Notes:

- Interactive prompts (like keychain/OAuth fixes) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) will skip prompts.
- `--fix` (alias for `--repair`) writes a backup to `~/.smart-agent-neo/smart-agent-neo.json.bak` and drops unknown config keys, listing each removal.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv SMART_AGENT_NEO_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value overrides your config file and can cause persistent “unauthorized” errors.

```bash
launchctl getenv SMART_AGENT_NEO_GATEWAY_TOKEN
launchctl getenv SMART_AGENT_NEO_GATEWAY_PASSWORD

launchctl unsetenv SMART_AGENT_NEO_GATEWAY_TOKEN
launchctl unsetenv SMART_AGENT_NEO_GATEWAY_PASSWORD
```
