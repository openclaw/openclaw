# OpenClaw Security & Trust

**Live:** [trust.openclaw.ai](https://trust.openclaw.ai)

## Documents

### Core Security

- [Threat Model](./THREAT-MODEL-ATLAS.md) - MITRE ATLAS-based threat model for the OpenClaw ecosystem
- [Contributing to the Threat Model](./CONTRIBUTING-THREAT-MODEL.md) - How to add threats, mitigations, and attack chains
- [Formal Verification](./formal-verification.md) - Formal verification techniques and practices

### HTTP Security (Task #11)

- [HTTP Security Guide](./http-security-guide.md) - Comprehensive guide for securing HTTP endpoints
- [HTTP Security Quick Reference](./http-security-quickref.md) - Quick reference for common patterns
- [Implementation Report](/SECURITY-HTTP-IMPLEMENTATION.md) - Task #11 implementation details
- [Completion Report](/TASK-11-COMPLETED.md) - Executive summary and verification

### SQL Security (Task #12)

- [SQL Injection Audit Report](./SQL_INJECTION_AUDIT_REPORT.md) - SQL injection vulnerability assessment
- [SQL Quick Reference](./SQL_INJECTION_QUICK_REFERENCE.md) - Safe query patterns

### Plugin Security

- [Plugin Registry Security](./PLUGIN-REGISTRY-SECURITY.md) - Plugin registry hardening

## Security Features

### HTTP Security Middleware

OpenClaw includes built-in security middleware for HTTP endpoints:

- **Security Headers (Helmet)** - XSS, clickjacking, MIME sniffing protection
- **Rate Limiting** - DoS protection (50-100 req/15min)
- **CSRF Protection** - Modern double-submit cookie pattern
- **Input Validation** - Schema-based validation
- **Authentication** - Bearer tokens, IP whitelisting
- **Body Parsing** - JSON parsing with size limits

**Status:** ✅ 4 critical extensions protected (33% coverage)

See [HTTP Security Guide](./http-security-guide.md) for implementation details.

## Reporting Vulnerabilities

See the [Trust page](https://trust.openclaw.ai) for full reporting instructions covering all repos.

For HTTP security middleware issues:

- Email: security@openclaw.ai
- GitHub: Use security issue template
- Do NOT open public issues for vulnerabilities

## Tools & Scripts

- `scripts/check-http-security.ts` - Automated security audit for HTTP endpoints
- [More tools coming soon]

## Contact

- **Jamieson O'Reilly** ([@theonejvo](https://twitter.com/theonejvo)) - Security & Trust
- Discord: #security channel
