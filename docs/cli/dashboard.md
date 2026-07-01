---
summary: "CLI reference for `openclaw dashboard` (open the Control UI)"
read_when:
  - You want to open the Control UI with your current token
  - You want to print the URL without launching a browser
title: "Dashboard"
---

# `openclaw dashboard`

Open the Control UI using your current auth.

```bash
openclaw dashboard
openclaw dashboard --no-open
openclaw dashboard --copy-token
```

Notes:

- `dashboard` resolves configured `gateway.auth.token` SecretRefs when possible.
- `dashboard` follows `gateway.tls.enabled`: TLS-enabled gateways print/open
  `https://` Control UI URLs and connect over `wss://`.
- If clipboard/browser delivery fails for a token-authenticated dashboard URL,
  `dashboard` logs a safe manual-auth hint naming `OPENCLAW_GATEWAY_TOKEN`,
  `gateway.auth.token`, and fragment key `token` without printing the token
  value.
- For SecretRef-managed tokens, `dashboard` prints/copies/opens a non-tokenized URL by default to avoid exposing external secrets in terminal output, clipboard history, or browser-launch arguments.
- Use `openclaw dashboard --copy-token` only when the Control UI prompts for a token and you need an explicit local recovery path. The command copies the resolved gateway token to the clipboard, never prints it, and opens a clean dashboard URL.
- If `gateway.auth.token` is SecretRef-managed but unresolved in this command path, the command prints a non-tokenized URL and explicit remediation guidance instead of embedding an invalid token placeholder.

## Related

- [CLI reference](/cli)
- [Dashboard](/web/dashboard)
