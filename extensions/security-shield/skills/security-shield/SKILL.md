---
name: security-shield
description: >
  Security Shield monitors all tool calls for dangerous commands and secret leaks.
  It automatically blocks destructive operations (rm -rf, reverse shells, crypto mining)
  and redacts API keys/tokens from tool output before they reach the conversation.
  All tool activity is logged to ~/.openclaw/security-audit.jsonl for audit review.
metadata:
  openclaw:
    emoji: 🛡️
    always: true
---

## Security Shield

This plugin is active by default and protects against:

### Dangerous command blocking

Tool calls containing destructive patterns are blocked before execution:

- `rm -rf`, `mkfs`, `dd of=/dev/`, `shred` — file/disk destruction
- `curl ... | bash`, `base64 -d | sh` — remote code execution
- `shutdown`, `reboot`, `kill -9 -1` — system disruption
- Reverse shell patterns (`bash -i >&`, `/dev/tcp/`)
- Crypto mining (`xmrig`, `stratum+tcp`)
- Access to `~/.ssh/`, `~/.aws/credentials`, `.env` files

### Secret leak detection

Tool output is scanned for known credential patterns:

- OpenAI (`sk-proj-*`), Anthropic (`sk-ant-api*`), Google (`AIza*`)
- GitHub tokens (`ghp_*`, `github_pat_*`)
- AWS keys (`AKIA*`), Stripe (`sk_live_*`), Slack (`xox*-*`)
- PEM private keys, Bearer tokens, credentials in URLs

Detected secrets are replaced with `[REDACTED:rule-id]` before reaching the LLM.

### Audit log

All tool calls are logged to `~/.openclaw/security-audit.jsonl` with:

- Timestamp, tool name, parameters (truncated to 500 chars)
- Whether the call was blocked and why
- Security findings (rule matches)
- Execution duration and errors

### Configuration

In `~/.openclaw/openclaw.json` under `plugins.security-shield`:

- `enforcement`: `"block"` (default), `"warn"`, or `"off"`
- `auditLog`: `true` (default) or `false`
- `leakDetection`: `true` (default) or `false`
