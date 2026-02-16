# OpenClaw

## What This Is

A personal AI assistant gateway that connects to messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, and more) and routes messages through a Pi agent runtime. v1.0 delivered security hardening (input screening, session isolation, plugin sandboxing, output filtering, tracing, audit logging). v1.1 delivered live testing stabilization — shared test helpers, custom reporter, all provider/gateway/browser/Telegram live tests verified green.

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
- ✓ SSRF/shell injection guards — existing
- ✓ Typed security events for auth, tool calls, injection, policy violations (SLOG-01) — v1.0
- ✓ No secrets in committed source; pre-commit hook (REPO-01) — v1.0
- ✓ API keys shown as prefix + length only (TOOL-02) — v1.0
- ✓ Configurable per-channel input detection sensitivity (INPT-01) — v1.0
- ✓ Cross-session isolation at data access layer (SESS-01) — v1.0
- ✓ Workspace plugins require explicit consent (PLUG-01) — v1.0
- ✓ Plugins declare capabilities; only declared APIs exposed (PLUG-02) — v1.0
- ✓ Per-channel Content Security Policy for agent responses (OUTP-01) — v1.0
- ✓ W3C Trace Context propagation through tool chains (TOOL-01) — v1.0
- ✓ Hash-chained append-only security event log (INFR-01) — v1.0
- ✓ Missing API keys produce clear skip messages (TINF-01) — v1.1
- ✓ Live test runner reports clear pass/fail diagnostics (TINF-02) — v1.1
- ✓ Individual live test files run in isolation (TINF-03) — v1.1
- ✓ All agent provider live tests pass or skip cleanly (AGNT-01 through AGNT-06) — v1.1
- ✓ Gateway CLI backend and model profiles live tests pass (GATE-01, GATE-02) — v1.1
- ✓ Browserless CDP live test verified (BMED-01) — v1.1
- ✓ Telegram e2e live test — bot connectivity + message delivery (CHAN-01) — v1.1

### Active

(No active requirements — define next milestone with `/gsd:new-milestone`)

### Out of Scope

- End-to-end encryption of message content — channel providers handle transport encryption
- Formal security certification (SOC2, ISO 27001) — practical hardening, not compliance
- Rewriting the agent runtime (Pi framework) — we harden around it, not inside it
- Mobile app security (iOS/Android/macOS) — separate concern, different attack surface
- Local LLM-based prompt injection classifier — high latency, GPU cost, second attack surface
- Full message content encryption at rest — single-user local system, use OS-level FDE
- Mutual TLS for channel connections — channel APIs use their own auth

## Context

Shipped v1.0 Security Hardening + v1.1 Live Testing & Stabilization.
~10K LOC security artifacts, 115+ tests, 0 regressions.
Live test infrastructure: describeLive helpers, custom LiveTestReporter, 11 live test files.
Tech stack: Node.js 22, TypeScript ESM, bun, Vitest, tsdown.

Known issues:
- Pre-existing flaky test: `src/infra/gateway-lock.test.ts` (intermittent timeout)
- CLI backend test cannot run inside Claude Code (environmental constraint)
- BMED-02 Deepgram audio test deferred
- Static LIVE_TEST_KEY_MAP requires manual update for new live tests

## Key Decisions

| Decision                                     | Rationale                                           | Outcome                                                          |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Harden around Pi framework, not inside it    | Proprietary dependency, can't modify                | ✓ Good — all hardening works at boundaries                       |
| Balanced approach (security vs UX)           | User wants practical resilience, not lockdown       | ✓ Good — fail-open delivery with fail-loud logging               |
| Systematic over reactive                     | Current pattern of reactive fixes isn't scaling     | ✓ Good — 5-phase structured approach delivered                   |
| Weighted scoring for input detection         | Binary match too noisy; graduated thresholds needed | ✓ Good — 3 sensitivity levels with configurable thresholds       |
| Proxy-based capability enforcement           | Preserves TypeScript types; runtime enforcement     | ✓ Good — legacy plugins get full access with deprecation warning |
| Promise-chain serialization for audit writes | Concurrent write safety without locks               | ✓ Good — same proven pattern as cron/run-log.ts                  |
| Non-blocking startup verification            | Avoid delaying gateway boot                         | ✓ Good — .then() pattern with tamper alerting                    |
| Run-keyed trace storage                      | Avoid circular imports with agent-events            | ✓ Good — parallel Map works cleanly                              |
| describeLive function-reference pattern      | Simpler than custom test runner hooks               | ✓ Good — describe/describe.skip with no framework coupling       |
| Static LIVE_TEST_KEY_MAP                     | Reliability over auto-detection                     | ✓ Good — 11 entries, maintainable                                |
| Direct fetch for Telegram e2e test           | No grammy dependency in tests                       | ✓ Good — mirrors browserless pattern                             |
| Telegram replaces WhatsApp as e2e target     | Telegram Bot API supports programmatic testing      | ✓ Good — full bot connectivity + send verification               |

## Constraints

- **Compatibility**: All existing channel integrations must continue working — no breaking changes to message flow
- **Performance**: Security checks must not add noticeable latency to message processing
- **Pi framework**: Cannot modify the embedded Pi agent core (`@mariozechner/pi-*` packages) — must work around it
- **Runtime**: Node.js >= 22, TypeScript ESM, bun package manager
- **Testing**: Security tests must be automated and run in CI (Vitest)

---

_Last updated: 2026-02-16 after v1.1 milestone completion_
