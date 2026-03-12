# VoltClaw

Enterprise-hardened fork of [OpenClaw](https://github.com/openclaw/openclaw) — the multi-channel AI gateway.

VoltClaw takes OpenClaw's multi-channel AI assistant and adds the security posture enterprises need: shell injection prevention, strict HTTP hardening, input validation at system boundaries, and defense-in-depth across the gateway stack.

## What is this?

OpenClaw is a personal AI assistant that runs on your own devices and connects to the channels you already use (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Microsoft Teams, Matrix, and more). It routes AI model responses through a gateway control plane, supports skills/plugins, and provides companion apps on macOS, iOS, and Android.

VoltClaw is a security-focused fork that hardens OpenClaw for enterprise deployment, where the threat model extends beyond a single trusted operator.

## Security Hardening (vs upstream OpenClaw)

### Shell Injection Prevention

- **Keychain credential reads** (`src/agents/cli-credentials.ts`): Replaced `execSync` (shell string interpolation) with `execFileSync` (binary + argv array). Environment-derived values like `CODEX_HOME` were previously interpolated directly into shell command strings.

- **Contributor script** (`scripts/update-clawtributors.ts`): Converted all shell command execution from `execSync` with string concatenation to `execFileSync` with argument arrays. Config-derived values (`seedCommit`, `rootCommit`) that flow from JSON files into git commands are now safe from injection.

- **Windows test paths** (`src/security/audit.test.ts`): Fixed `icacls` invocation to use `execFileSync`, preventing path-based injection.

### HTTP Response Hardening

- **X-Frame-Options: DENY** added to all gateway HTTP responses by default, preventing clickjacking attacks against the gateway API and control UI.

- **Content-Type enforcement** on JSON API endpoints. Requests with non-JSON `Content-Type` headers (e.g., `application/x-www-form-urlencoded` from cross-origin form submissions) are rejected with HTTP 415 before body parsing.

### What was already solid upstream

The OpenClaw codebase has strong security foundations that VoltClaw inherits:

- **Timing-safe secret comparison** via `safeEqualSecret` (SHA-256 + `crypto.timingSafeEqual`) on all auth paths
- **SSRF guards** with DNS pinning and IP classification
- **Prototype pollution blocking** with recursive key filtering
- **Path traversal prevention** with symlink/hardlink checks and TOCTOU mitigation
- **Rate limiting** on authentication endpoints with per-IP sliding windows
- **Cryptographically secure randomness** (`crypto.randomBytes`/`randomUUID`) for all tokens and secrets
- **No hardcoded secrets** — proper masking in logs, secret-scanning baseline
- **Safe process execution** (`execFile` over `exec`, `shell: false` enforced in `src/process/exec.ts`)

## Install

Runtime: **Node 22+**

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

See the upstream [Getting Started](https://docs.openclaw.ai/start/getting-started) guide for full setup instructions.

## Development

```bash
pnpm install
pnpm build         # typecheck + build
pnpm check         # lint + format check
pnpm test          # run test suite
```

## Project Structure

| Directory       | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `src/`          | Core CLI, gateway, channels, agents, security   |
| `src/gateway/`  | HTTP/WS server, auth, hooks, control UI         |
| `src/security/` | Audit, scanning, secret comparison, temp guards |
| `src/process/`  | Safe child process execution                    |
| `extensions/`   | Channel plugins (Teams, Matrix, Zalo, etc.)     |
| `apps/`         | macOS, iOS, Android companion apps              |
| `scripts/`      | Build, release, contributor tooling             |
| `docs/`         | Documentation (Mintlify-hosted)                 |

## Upstream

VoltClaw tracks [openclaw/openclaw](https://github.com/openclaw/openclaw) `main`. Security patches are applied on top. Upstream features flow in via rebase.

## License

MIT (same as upstream OpenClaw)
