# Qwen Portal OAuth (Clawdbot plugin)

OAuth provider plugin for **Qwen Portal** (free-tier OAuth).

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
clawdbot plugins enable qwen-portal-auth
```

Restart the Gateway after enabling.

## Authenticate

```bash
clawdbot models auth login --provider qwen-portal --set-default
```

## Notes

- Qwen OAuth uses a device-code login flow.
- Tokens expire periodically; re-run login if requests fail.
