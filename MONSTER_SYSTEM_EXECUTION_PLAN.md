# Monster System Execution Plan

Date: 2026-03-04
Program: OpenClaw hardening + performance + security + Telegram production readiness

## Mission

Ship a production-grade, high-performance, secure, observable multi-channel system with fully validated Telegram operations and complete ECC skill-import governance.

## Program KPIs

- Availability: 99.95% for core message handling.
- Telegram send success: >=99.9% in soak.
- Latency: p95 first-token <2.5s; p99 full response <8s for standard requests.
- Security: 0 open critical findings in release branch.
- Quality: deterministic CI pass rate >=98% with controlled flaky-test policy.

## Streams and Exit Gates

### Stream A: ECC Import Pipeline Completion

- [x] Replace placeholder clone/install flow with executable implementation.
- [x] Add root-path safety checks for install/remove operations.
- [x] Add branch fallback logic (`main` -> `master`) for clone.
- [x] Add curated README parsing to discover repo links.
- [x] Add fallback behavior when curated README is unavailable.
- [x] Add tests for URL parsing, path safety, README parsing, install copy.
- [ ] Add integrity checks (archive hash/signature policy) for imported skills.
- [ ] Add quarantine path + reject artifact retention for failed audits.
- Exit gate:
  - `pnpm tsgo` green
  - ECC import tests green
  - Mandatory audit cannot be bypassed

### Stream B: Telegram Production Readiness

- [x] Stabilize Telegram media tests and DNS pinning behavior in restricted env.
- [x] Keep Telegram focused suites green after ECC changes.
- [ ] Execute live Telegram E2E against real bot token/config.
- [ ] Run 24h Telegram soak test and collect reliability metrics.
- [ ] Add incident runbook validation for Telegram outages and API failures.
- Exit gate:
  - Live E2E pass evidence
  - Soak test report with error budget results

### Stream C: Reliability + Observability

- [ ] Define RED metrics set per channel (rate, errors, duration).
- [ ] Add trace spans across inbound -> routing -> provider -> outbound.
- [ ] Add alerting thresholds for queue lag, error spikes, and send failures.
- [ ] Add dead-letter/replay workflow for failed outbound deliveries.
- Exit gate:
  - Dashboard + alert policy committed
  - Replay path tested

### Stream D: Security + Supply Chain

- [ ] Threat model gateway/channel/plugin boundaries.
- [ ] Add dependency audit + SBOM + provenance artifacts to CI.
- [ ] Add secret exposure guardrail checks.
- [ ] Add security regression tests for SSRF and unsafe command vectors.
- Exit gate:
  - Security pipeline green
  - No critical unresolved security findings

### Stream E: Performance

- [ ] Define benchmark profiles (single, burst, sustained, media-heavy).
- [ ] Add perf CI stage with latency budget thresholds.
- [ ] Profile and optimize top hotspots.
- Exit gate:
  - KPI targets met in benchmark reports
  - Perf regressions gate merges

## Current Implementation Delta (This Run)

- ECC collection manager now has real clone/fetch/install/remove behavior with path safety controls.
- Added three user-specified skill repositories to recommended list:
  - `https://github.com/gsd-build/get-shit-done.git`
  - `https://github.com/sickn33/antigravity-awesome-skills.git`
  - `https://github.com/VoltAgent/awesome-openclaw-skills.git`
- Added test suite for collection manager core behavior.

## Verification Commands

- `pnpm tsgo`
- `pnpm exec vitest run extensions/ecc-integration/src/skills/collection-manager.test.ts`
- `pnpm exec vitest run src/telegram/bot.create-telegram-bot.test.ts src/telegram/bot.test.ts`

## Immediate Next Steps

1. Implement signed integrity validation/quarantine in ECC import pipeline.
2. Add live Telegram E2E script and runbook automation.
3. Add observability schema and initial alert rules for Telegram path.
