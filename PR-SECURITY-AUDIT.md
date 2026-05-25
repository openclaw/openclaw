# feat(cli): add `security-audit` command for credential and permission scanning

## Summary

Adds a new `openclaw security-audit` command that scans the user's environment for common security issues:

- **Credential scanning:** Detects leaked API keys, tokens, private keys, and database connection strings in `~/.openclaw/` and `~/.ssh/`
- **Permission audit:** Checks that sensitive files (configs, credentials, SSH keys, shell history) have restrictive permissions
- **Network audit:** Identifies unexpected listening services and flags gateway exposure on all interfaces

## Why

This extends the security posture work started in `doctor`'s plaintext-secret warnings to cover filesystem credential exposure, file permission hardening, and network exposure detection.

OpenClaw manages high-value secrets (model API keys, Telegram tokens, gateway tokens, SSH configs). Currently, `doctor` validates config syntax and warns about plaintext secrets in `openclaw.json`, but there's no filesystem-wide scanner for:

- Secrets accidentally committed to agent workspaces
- `.env` files or shell history with exposed credentials
- World-readable SSH keys or credential directories
- Unexpected network listeners that could indicate compromise

This command is the natural continuation of that security direction.

## Usage

```bash
# Full scan (default)
openclaw security-audit

# JSON output for CI integration
openclaw security-audit --json

# Only show critical and high findings
openclaw security-audit --severity-min high

# Skip network checks (useful in containers without ss/netstat)
openclaw security-audit --no-network

# Only scan credentials
openclaw security-audit --no-permissions --no-network
```

## Exit Codes

| Code | Meaning                    |
| ---- | -------------------------- |
| 0    | No findings                |
| 1    | Only LOW/MEDIUM findings   |
| 2    | HIGH findings detected     |
| 3    | CRITICAL findings detected |

## Detected Secret Types

- OpenAI API keys (`sk-...`)
- GitHub personal access tokens (`ghp_...`)
- Telegram bot tokens
- NVIDIA API keys (`nvapi-...`)
- Ethereum private keys (hex)
- AWS access key IDs (`AKIA...`)
- Database connection strings
- Generic API keys and plaintext passwords

## Implementation

- **Zero dependencies:** Uses only Node.js built-ins (`fs`, `path`, `child_process`, `os`)
- **Safe by design:** Skips binary files, node_modules, and `.git`; catches permission errors silently
- **Auto-redacts:** Never outputs the actual secret values — only file paths and line numbers
- **Fast path:** Each audit category can be skipped independently

## Tests

- Unit tests for the command dispatcher and options parsing
- Unit tests for credential pattern matching
- Unit tests for permission audit with missing paths
- Unit tests for network audit graceful degradation

## Files Changed

| File                                                | Action                              |
| --------------------------------------------------- | ----------------------------------- |
| `src/commands/security-audit.ts`                    | New — main command entry point      |
| `src/commands/security-audit/types.ts`              | New — shared types                  |
| `src/commands/security-audit/credential-scanner.ts` | New — secret detection engine       |
| `src/commands/security-audit/permission-audit.ts`   | New — file permission checker       |
| `src/commands/security-audit/network-audit.ts`      | New — network exposure scanner      |
| `src/commands/security-audit.test.ts`               | New — unit tests                    |
| `src/cli/program/register.maintenance.ts`           | Modified — add command registration |
| `src/cli/program/core-command-descriptors.ts`       | Modified — add command descriptor   |
