# Security Policy

If you believe you've found a security issue in OpenClaw, please report it privately.

## Reporting

- Email: `steipete@gmail.com`
- What to include: reproduction steps, impact assessment, and (if possible) a minimal PoC.

### Please redact secrets

If you include logs, screenshots, configs, or command output, redact any secrets (tokens, API keys, pairing codes, phone numbers, cookies, etc.). If you are unsure whether something is sensitive, assume it is and redact it.

## Bug Bounties

OpenClaw is a labor of love. There is no bug bounty program and no budget for paid reports. Please still disclose responsibly so we can fix issues quickly.
The best way to help the project right now is by sending PRs.

## Out of Scope

- Public Internet Exposure
- Using OpenClaw in ways that the docs recommend not to
- Prompt injection attacks

## Operational Guidance

For threat model + hardening guidance (including `openclaw security audit --deep` and `--fix`), see:

- `docs/gateway/security/index.md` (published in the docs site at `/gateway/security`)

### Quick hardening checklist

- Keep the web UI bound to localhost only (or behind a trusted VPN).
- Use least-privilege credentials (separate bot accounts; minimal channel permissions).
- Store secrets in a proper secret manager or OS keychain (avoid plaintext `.env` files when possible).
- Treat chat inputs as untrusted: review/confirm before running destructive commands or enabling powerful tools.
- Rotate tokens if you suspect exposure (especially after pasting logs/config into public issues).

### Web Interface Safety

OpenClaw's web interface is intended for local use only. Do **not** bind it to the public internet; it is not hardened for public exposure.

## Runtime Requirements

### Node.js Version

OpenClaw requires **Node.js 22.12.0 or later** (LTS). This version includes important security patches:

- CVE-2025-59466: async_hooks DoS vulnerability
- CVE-2026-21636: Permission model bypass vulnerability

Verify your Node.js version:

```bash
node --version  # Should be v22.12.0 or later
```

### Docker Security

When running OpenClaw in Docker:

1. The official image runs as a non-root user (`node`) for reduced attack surface
2. Use `--read-only` flag when possible for additional filesystem protection
3. Limit container capabilities with `--cap-drop=ALL`

Example secure Docker run:

```bash
docker run --read-only --cap-drop=ALL \
  -v openclaw-data:/app/data \
  openclaw/openclaw:latest
```

## Security Scanning

This project uses `detect-secrets` for automated secret detection in CI/CD.
See `.detect-secrets.cfg` for configuration and `.secrets.baseline` for the baseline.

Run locally:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
