# Security Policy

If you believe you've found a security issue in OpenClaw, please report it privately.

## Reporting

- Email: `steipete@gmail.com`
- What to include: reproduction steps, impact assessment, and (if possible) a minimal PoC.

## Bug Bounties

OpenClaw is a labor of love. There is no bug bounty program and no budget for paid reports. Please still disclose responsibly so we can fix issues quickly.
The best way to help the project right now is by sending PRs.

## Out of Scope

- Public Internet Exposure
- Using OpenClaw in ways that the docs recommend not to
- Prompt injection attacks (see note below)

### Note on Prompt Injection

Prompt injection is listed as "out of scope" for security reports because:

1. **Inherent to LLM systems**: Prompt injection is a fundamental challenge with all LLM-based applications, not a bug specific to OpenClaw.
2. **Model-level mitigation**: Defense primarily depends on the underlying model provider (Anthropic, OpenAI, etc.).
3. **Personal assistant design**: OpenClaw is designed as a personal assistant with intentional access to tools and messaging.

**Mitigation recommendations for users concerned about prompt injection:**

- Use `dmPolicy="pairing"` (default) to require approval before responding to unknown senders
- Configure allowlists (`allowFrom`) to limit who can interact with your assistant
- Use `agents.defaults.sandbox.mode: "non-main"` to sandbox non-main sessions
- Review the [Security guide](https://docs.openclaw.ai/gateway/security/) for hardening options
- Run `openclaw security audit --deep` to identify risky configurations

## Operational Guidance

For threat model + hardening guidance (including `openclaw security audit --deep` and `--fix`), see:

- `https://docs.openclaw.ai/gateway/security/`

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
