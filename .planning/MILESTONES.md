# Milestones

## v1.0 Security Hardening (Shipped: 2026-02-16)

**Phases completed:** 5 phases, 11 plans, 0 tasks

**Key accomplishments:**

- Unified API key masking with canonical `maskApiKey` utility — prefix-only format across all display sites
- Typed security event system with 12 event types routed through SubsystemLogger
- Weighted input screening with per-channel sensitivity (lenient/moderate/strict) and pipeline integration
- Cross-session data isolation enforced at the data access layer for transcripts and memory
- Plugin consent gates and Proxy-based capability-scoped API enforcement
- Per-channel output Content Security Policy with 6 detect+redact rules
- W3C Trace Context propagation through tool execution chains and sub-agent spawns
- Hash-chained tamper-evident audit log with CLI verification and gateway startup integrity checks

**Stats:** 115 tests, ~10K LOC across security artifacts, 0 regressions

---

## v1.1 Live Testing & Stabilization (Shipped: 2026-02-16)

**Phases completed:** 3 phases (6-8), 6 plans, 12 tasks

**Key accomplishments:**

- Shared live test helper module (`describeLive`, `classifyLiveError`, `withLiveRetry`) with 26 unit tests
- Custom LiveTestReporter with per-test colored status, error classification, and missing API key summary
- All 6 agent provider live tests verified passing or skipping cleanly
- Gateway live tests fixed (enum values, server call signature) and passing
- Browser CDP live test verified against Browserless Docker
- Telegram e2e live test — bot connectivity + message delivery via direct fetch

**Stats:** 29 files changed, ~2.1K LOC, 12 tasks across 6 plans, ~24 min total execution

---

