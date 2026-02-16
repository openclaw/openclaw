# Roadmap: OpenClaw

## Milestones

- ✅ **v1.0 Security Hardening** — Phases 1-5 (shipped 2026-02-16)
- 🚧 **v1.1 Live Testing & Stabilization** — Phases 6-8 (in progress)

## Phases

<details>
<summary>✅ v1.0 Security Hardening (Phases 1-5) — SHIPPED 2026-02-16</summary>

- [x] Phase 1: Foundation & Repo Hygiene (3/3 plans) — Security event logging, secret scrubbing, API key masking
- [x] Phase 2: Input & Session Hardening (2/2 plans) — Configurable input detection, cross-session isolation
- [x] Phase 3: Plugin Security (2/2 plans) — Explicit consent and capability-scoped plugin loading
- [x] Phase 4: Output Controls & Execution Tracing (2/2 plans) — Per-channel output CSP, W3C trace context
- [x] Phase 5: Tamper-Evident Audit Infrastructure (2/2 plans) — Hash-chained audit log, CLI verify, startup check

</details>

### 🚧 v1.1 Live Testing & Stabilization (In Progress)

**Milestone Goal:** All live tests pass, WhatsApp works end-to-end, live test infrastructure improved for ongoing reliability.

- [ ] **Phase 6: Test Infrastructure** — Clear diagnostics, graceful skips, and isolated test execution
- [ ] **Phase 7: Agent & Gateway Live Tests** — All agent provider and gateway live tests green
- [ ] **Phase 8: Browser, Media & WhatsApp** — Browser sessions, audio transcription, and WhatsApp e2e working

## Phase Details

### Phase 6: Test Infrastructure
**Goal**: Developer gets clear, actionable feedback from live test runs regardless of environment configuration
**Depends on**: Nothing (foundation for this milestone)
**Requirements**: TINF-01, TINF-02, TINF-03
**Success Criteria** (what must be TRUE):
  1. Running a live test without the required API key produces a clear skip message naming the missing key, not a cryptic failure or stack trace
  2. The live test runner output shows each test file with an unambiguous pass/fail/skip status and a summary count at the end
  3. Any single live test file can be run independently with `bun run test:live <file>` without requiring other test files or shared setup to execute first
**Plans:** 2 plans

Plans:
- [ ] 06-01-PLAN.md — Shared live test helpers (skip messaging, error classification, retry) + refactor all live tests
- [ ] 06-02-PLAN.md — Custom Vitest reporter for live test diagnostics + wire into config

### Phase 7: Agent & Gateway Live Tests
**Goal**: Every agent provider integration and gateway CLI/profile test passes against real services
**Depends on**: Phase 6
**Requirements**: AGNT-01, AGNT-02, AGNT-03, AGNT-04, AGNT-05, AGNT-06, GATE-01, GATE-02
**Success Criteria** (what must be TRUE):
  1. `bun run test:live` with valid Anthropic, Gemini, MiniMax, and Zai API keys results in all agent provider tests passing
  2. Pi embedded extra params live test passes — agent correctly handles additional parameters in embedded mode
  3. Agent model profiles live test passes — switching between configured model profiles works end-to-end
  4. Gateway CLI backend live test passes — CLI commands execute correctly against a running gateway
  5. Gateway model profiles live test passes — profile configuration is correctly loaded and applied
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: Browser, Media & WhatsApp
**Goal**: External service integrations (Browserless, Deepgram, WhatsApp) work end-to-end
**Depends on**: Phase 6
**Requirements**: BMED-01, BMED-02, WHAP-01
**Success Criteria** (what must be TRUE):
  1. Browserless CDP session live test passes — agent can spawn a browser session, navigate, and return results
  2. Deepgram audio transcription live test passes — audio input is transcribed and returned to the agent
  3. A WhatsApp message sent to OpenClaw receives an agent-generated reply back through WhatsApp
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

## Progress

**Execution Order:**
Phase 6 first. Phases 7 and 8 can execute in parallel after Phase 6 completes.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Repo Hygiene | v1.0 | 3/3 | Complete | 2026-02-15 |
| 2. Input & Session Hardening | v1.0 | 2/2 | Complete | 2026-02-16 |
| 3. Plugin Security | v1.0 | 2/2 | Complete | 2026-02-16 |
| 4. Output Controls & Execution Tracing | v1.0 | 2/2 | Complete | 2026-02-16 |
| 5. Tamper-Evident Audit Infrastructure | v1.0 | 2/2 | Complete | 2026-02-16 |
| 6. Test Infrastructure | v1.1 | 0/2 | Planned | - |
| 7. Agent & Gateway Live Tests | v1.1 | 0/? | Not started | - |
| 8. Browser, Media & WhatsApp | v1.1 | 0/? | Not started | - |
