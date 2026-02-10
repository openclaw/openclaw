# Security Policy（轉為繁體中文）
（轉為繁體中文）
If you believe you've found a security issue in OpenClaw, please report it privately.（轉為繁體中文）
（轉為繁體中文）
## Reporting（轉為繁體中文）
（轉為繁體中文）
Report vulnerabilities directly to the repository where the issue lives:（轉為繁體中文）
（轉為繁體中文）
- **Core CLI and gateway** — [openclaw/openclaw](https://github.com/openclaw/openclaw)（轉為繁體中文）
- **macOS desktop app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/macos)（轉為繁體中文）
- **iOS app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/ios)（轉為繁體中文）
- **Android app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/android)（轉為繁體中文）
- **ClawHub** — [openclaw/clawhub](https://github.com/openclaw/clawhub)（轉為繁體中文）
- **Trust and threat model** — [openclaw/trust](https://github.com/openclaw/trust)（轉為繁體中文）
（轉為繁體中文）
For issues that don't fit a specific repo, or if you're unsure, email **security@openclaw.ai** and we'll route it.（轉為繁體中文）
（轉為繁體中文）
For full reporting instructions see our [Trust page](https://trust.openclaw.ai).（轉為繁體中文）
（轉為繁體中文）
### Required in Reports（轉為繁體中文）
（轉為繁體中文）
1. **Title**（轉為繁體中文）
2. **Severity Assessment**（轉為繁體中文）
3. **Impact**（轉為繁體中文）
4. **Affected Component**（轉為繁體中文）
5. **Technical Reproduction**（轉為繁體中文）
6. **Demonstrated Impact**（轉為繁體中文）
7. **Environment**（轉為繁體中文）
8. **Remediation Advice**（轉為繁體中文）
（轉為繁體中文）
Reports without reproduction steps, demonstrated impact, and remediation advice will be deprioritized. Given the volume of AI-generated scanner findings, we must ensure we're receiving vetted reports from researchers who understand the issues.（轉為繁體中文）
（轉為繁體中文）
## Security & Trust（轉為繁體中文）
（轉為繁體中文）
**Jamieson O'Reilly** ([@theonejvo](https://twitter.com/theonejvo)) is Security & Trust at OpenClaw. Jamieson is the founder of [Dvuln](https://dvuln.com) and brings extensive experience in offensive security, penetration testing, and security program development.（轉為繁體中文）
（轉為繁體中文）
## Bug Bounties（轉為繁體中文）
（轉為繁體中文）
OpenClaw is a labor of love. There is no bug bounty program and no budget for paid reports. Please still disclose responsibly so we can fix issues quickly.（轉為繁體中文）
The best way to help the project right now is by sending PRs.（轉為繁體中文）
（轉為繁體中文）
## Out of Scope（轉為繁體中文）
（轉為繁體中文）
- Public Internet Exposure（轉為繁體中文）
- Using OpenClaw in ways that the docs recommend not to（轉為繁體中文）
- Prompt injection attacks（轉為繁體中文）
（轉為繁體中文）
## Operational Guidance（轉為繁體中文）
（轉為繁體中文）
For threat model + hardening guidance (including `openclaw security audit --deep` and `--fix`), see:（轉為繁體中文）
（轉為繁體中文）
- `https://docs.openclaw.ai/gateway/security`（轉為繁體中文）
（轉為繁體中文）
### Web Interface Safety（轉為繁體中文）
（轉為繁體中文）
OpenClaw's web interface is intended for local use only. Do **not** bind it to the public internet; it is not hardened for public exposure.（轉為繁體中文）
（轉為繁體中文）
## Runtime Requirements（轉為繁體中文）
（轉為繁體中文）
### Node.js Version（轉為繁體中文）
（轉為繁體中文）
OpenClaw requires **Node.js 22.12.0 or later** (LTS). This version includes important security patches:（轉為繁體中文）
（轉為繁體中文）
- CVE-2025-59466: async_hooks DoS vulnerability（轉為繁體中文）
- CVE-2026-21636: Permission model bypass vulnerability（轉為繁體中文）
（轉為繁體中文）
Verify your Node.js version:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
node --version  # Should be v22.12.0 or later（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### Docker Security（轉為繁體中文）
（轉為繁體中文）
When running OpenClaw in Docker:（轉為繁體中文）
（轉為繁體中文）
1. The official image runs as a non-root user (`node`) for reduced attack surface（轉為繁體中文）
2. Use `--read-only` flag when possible for additional filesystem protection（轉為繁體中文）
3. Limit container capabilities with `--cap-drop=ALL`（轉為繁體中文）
（轉為繁體中文）
Example secure Docker run:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
docker run --read-only --cap-drop=ALL \（轉為繁體中文）
  -v openclaw-data:/app/data \（轉為繁體中文）
  openclaw/openclaw:latest（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Security Scanning（轉為繁體中文）
（轉為繁體中文）
This project uses `detect-secrets` for automated secret detection in CI/CD.（轉為繁體中文）
See `.detect-secrets.cfg` for configuration and `.secrets.baseline` for the baseline.（轉為繁體中文）
（轉為繁體中文）
Run locally:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pip install detect-secrets==1.5.0（轉為繁體中文）
detect-secrets scan --baseline .secrets.baseline（轉為繁體中文）
```（轉為繁體中文）
