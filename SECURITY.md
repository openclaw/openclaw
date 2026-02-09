# Security Policy

If you believe you've found a security issue in EasyHub, please report it privately.

## Reporting

For full reporting instructions - including which repo to report to and how - see our [Trust page](https://trust.EasyHub.ai).

Include: reproduction steps, impact assessment, and (if possible) a minimal PoC.

## Security & Trust

**Jamieson O'Reilly** ([@theonejvo](https://twitter.com/theonejvo)) is Security & Trust at EasyHub. Jamieson is the founder of [Dvuln](https://dvuln.com) and brings extensive experience in offensive security, penetration testing, and security program development.

## Bug Bounties

EasyHub is a labor of love. There is no bug bounty program and no budget for paid reports. Please still disclose responsibly so we can fix issues quickly.
The best way to help the project right now is by sending PRs.

## Out of Scope

- Public Internet Exposure
- Using EasyHub in ways that the docs recommend not to
- Prompt injection attacks

## Operational Guidance

For threat model + hardening guidance (including `EasyHub security audit --deep` and `--fix`), see:

- `https://docs.EasyHub.ai/gateway/security`

### Web Interface Safety

EasyHub's web interface is intended for local use only. Do **not** bind it to the public internet; it is not hardened for public exposure.

## Runtime Requirements

### Node.js Version

EasyHub requires **Node.js 22.12.0 or later** (LTS). This version includes important security patches:

- CVE-2025-59466: async_hooks DoS vulnerability
- CVE-2026-21636: Permission model bypass vulnerability

Verify your Node.js version:

```bash
node --version  # Should be v22.12.0 or later
```

### Docker Security

When running EasyHub in Docker:

1. The official image runs as a non-root user (`node`) for reduced attack surface
2. Use `--read-only` flag when possible for additional filesystem protection
3. Limit container capabilities with `--cap-drop=ALL`

Example secure Docker run:

```bash
docker run --read-only --cap-drop=ALL \
  -v EasyHub-data:/app/data \
  EasyHub/EasyHub:latest
```

## Security Scanning

This project uses `detect-secrets` for automated secret detection in CI/CD.
See `.detect-secrets.cfg` for configuration and `.secrets.baseline` for the baseline.

Run locally:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
