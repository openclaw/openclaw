# OpenClaw Security Hardening

## What This Is

A security hardening initiative for OpenClaw, a personal AI assistant gateway that connects to messaging channels and routes messages through an AI agent runtime. The project hardens the application against prompt injection, tool abuse, data exfiltration, and cross-channel leakage — while keeping all channel and LLM provider integrations fully functional. It also cleans the repo of any exposed personal information or secrets.

## Core Value

Inbound messages from any channel cannot manipulate the agent into leaking system prompts, accessing unauthorized tools, exfiltrating user data, or affecting other channels' sessions.

## Requirements

### Validated

- ✓ Multi-channel messaging (Telegram, WhatsApp, Discord, Slack, Signal, iMessage, LINE, Feishu) — existing
- ✓ AI agent execution with Pi framework integration — existing
- ✓ Tool execution in sandboxed environments (Docker, PTY, browser) — existing
- ✓ Session-based conversation persistence — existing
- ✓ Config validation with Zod schemas — existing
- ✓ Auth profiles with provider rotation and failover — existing
- ✓ Tool policy system (allowlists/blocklists) — existing
- ✓ Gateway authentication (token/password) — existing
- ✓ SSRF/shell injection guards (recent hardening in 2026.2.14+) — existing

### Active

- [ ] Prompt injection defense for inbound messages across all channels
- [ ] Tool call validation and abuse prevention beyond current allowlists
- [ ] System prompt / config / identity data exfiltration prevention
- [ ] Cross-channel session isolation (one channel can't access another's data)
- [ ] Output filtering to prevent leaking internal state in responses
- [ ] Repo hygiene: remove any hardcoded secrets, personal info, or sensitive config from code and git history
- [ ] Input sanitization layer for all channel adapters
- [ ] Audit logging for security-relevant events (tool calls, auth failures, suspicious prompts)

### Out of Scope

- End-to-end encryption of message content — channel providers handle transport encryption
- Formal security certification (SOC2, ISO 27001) — this is practical hardening, not compliance
- Rewriting the agent runtime (Pi framework) — we harden around it, not inside it
- Mobile app security (iOS/Android/macOS) — separate concern, different attack surface

## Context

- OpenClaw has been receiving public attention and criticism for prompt injection vulnerabilities
- The codebase already has some security measures (SSRF guards, tool policies, sandbox isolation) but they're reactive and incomplete
- Codebase concerns audit flagged: type system gaps allowing implicit leaks, 1048 type assertions, silent failures in message extraction, unbounded memory growth, and missing security test coverage for edge cases
- The gateway runs as a long-lived process handling multiple channels concurrently — session isolation is critical
- Recent commits show security fixes are happening reactively (Discord role allowlist bug, various hardening patches) rather than systematically

## Constraints

- **Compatibility**: All existing channel integrations must continue working — no breaking changes to message flow
- **Performance**: Security checks must not add noticeable latency to message processing
- **Pi framework**: Cannot modify the embedded Pi agent core (`@mariozechner/pi-*` packages) — must work around it
- **Runtime**: Node.js >= 22, TypeScript ESM, bun package manager
- **Testing**: Security tests must be automated and run in CI (Vitest)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Harden around Pi framework, not inside it | Proprietary dependency, can't modify | — Pending |
| Balanced approach (security vs UX) | User wants practical resilience, not lockdown | — Pending |
| Systematic over reactive | Current pattern of reactive fixes isn't scaling | — Pending |

---
*Last updated: 2026-02-15 after initialization*
